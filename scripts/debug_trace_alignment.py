#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import math
import statistics
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Iterable
from uuid import UUID

from ezmsg.core.graphcontext import GraphContext
from ezmsg.core.graphmeta import (
    ProcessProfilingSnapshot,
    ProfilingStreamControl,
    ProfilingTraceControl,
    ProfilingTraceSample,
)
from ezmsg.core.netprotocol import Address


DEFAULT_METRICS = [
    "publish_delta_ns",
    "lease_time_ns",
    "attributable_backpressure_ns",
]


@dataclass
class CapturedSample:
    arrival_index: int
    process_id: UUID
    timestamp: float
    metric: str
    endpoint_id: str
    topic: str
    value: float
    sample_seq: int | None


def _percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    if len(values) == 1:
        return values[0]
    k = (len(values) - 1) * (pct / 100.0)
    lower = int(math.floor(k))
    upper = int(math.ceil(k))
    if lower == upper:
        return values[lower]
    weight = k - lower
    return values[lower] * (1.0 - weight) + values[upper] * weight


def _stats(values: Iterable[float]) -> dict[str, float]:
    data = sorted(values)
    if not data:
        return {
            "count": 0.0,
            "min": 0.0,
            "p50": 0.0,
            "p95": 0.0,
            "mean": 0.0,
            "max": 0.0,
        }
    return {
        "count": float(len(data)),
        "min": data[0],
        "p50": _percentile(data, 50.0),
        "p95": _percentile(data, 95.0),
        "mean": statistics.fmean(data),
        "max": data[-1],
    }


def _longest_absent_run(metric_presence_by_batch: list[set[str]], metric: str) -> int:
    best = 0
    current = 0
    for present in metric_presence_by_batch:
        if metric in present:
            current = 0
            continue
        current += 1
        best = max(best, current)
    return best


def _find_process_for_unit(graph_snapshot: object, unit_address: str) -> UUID | None:
    processes = getattr(graph_snapshot, "processes", {})
    for process_id, process_meta in processes.items():
        units = getattr(process_meta, "units", [])
        if unit_address in units:
            return process_id
    return None


def _find_matching_process(
    profiling_by_process: dict[UUID, ProcessProfilingSnapshot],
    *,
    publisher_topic: str | None,
    publisher_endpoint_id: str | None,
) -> UUID | None:
    for process_id in sorted(profiling_by_process.keys(), key=str):
        snap = profiling_by_process[process_id]
        publishers = list(snap.publishers.values())
        if publisher_topic is not None and not any(
            pub.topic == publisher_topic for pub in publishers
        ):
            continue
        if publisher_endpoint_id is not None and not any(
            pub.endpoint_id == publisher_endpoint_id for pub in publishers
        ):
            continue
        return process_id
    return None


def _select_publisher(
    process_profile: ProcessProfilingSnapshot,
    *,
    publisher_topic: str | None,
    publisher_endpoint_id: str | None,
) -> tuple[str, str]:
    publishers = sorted(
        process_profile.publishers.values(),
        key=lambda pub: (pub.topic, pub.endpoint_id),
    )
    if not publishers:
        raise RuntimeError("Selected process has no publishers in profiling snapshot.")

    for pub in publishers:
        if publisher_topic is not None and pub.topic != publisher_topic:
            continue
        if publisher_endpoint_id is not None and pub.endpoint_id != publisher_endpoint_id:
            continue
        return pub.topic, pub.endpoint_id

    raise RuntimeError(
        "Could not find a publisher in the selected process that matches "
        f"topic={publisher_topic!r}, endpoint_id={publisher_endpoint_id!r}."
    )


def _parse_metrics(raw: str) -> list[str]:
    metrics = [item.strip() for item in raw.split(",") if item.strip()]
    return metrics or list(DEFAULT_METRICS)


def _print_metric_line(name: str, counts: Counter[str], seq_missing: Counter[str]) -> None:
    total = counts.get(name, 0)
    missing = seq_missing.get(name, 0)
    with_seq = total - missing
    print(
        f"- {name}: total={total}, with_seq={with_seq}, without_seq={missing}",
    )


def _print_delta_stats(title: str, deltas_ms: list[float], total: int, matched: int) -> None:
    st = _stats(deltas_ms)
    unmatched = max(0, total - matched)
    pct = (100.0 * matched / total) if total > 0 else 0.0
    print(
        f"- {title}: matched={matched}/{total} ({pct:.1f}%), unmatched={unmatched}, "
        f"delta_ms[min/p50/p95/mean/max]="
        f"{st['min']:.4f}/{st['p50']:.4f}/{st['p95']:.4f}/{st['mean']:.4f}/{st['max']:.4f}",
    )


async def _run(args: argparse.Namespace) -> None:
    graph_address = Address.from_string(args.graph_address) if args.graph_address else None
    metrics = _parse_metrics(args.metrics)

    process_id_arg = UUID(args.process_id) if args.process_id else None
    process_id: UUID | None = process_id_arg
    route_unit: str | None = args.unit_address
    publisher_topic: str | None = args.publisher_topic
    publisher_endpoint_id: str | None = args.publisher_endpoint_id
    subscriber_topic: str | None = args.subscriber_topic

    stream = None
    control_applied = False
    t0 = time.monotonic()
    async with GraphContext(graph_address=graph_address, auto_start=False) as ctx:
        graph_snapshot, profiling_by_process = await asyncio.gather(
            ctx.snapshot(),
            ctx.profiling_snapshot_all(timeout_per_process=args.timeout),
        )
        if not graph_snapshot.processes:
            raise RuntimeError("No processes are present in current graph snapshot.")

        if process_id is None and route_unit is not None:
            process_id = _find_process_for_unit(graph_snapshot, route_unit)
            if process_id is None:
                raise RuntimeError(f"unit_address '{route_unit}' was not found in any process.")

        if process_id is None:
            process_id = _find_matching_process(
                profiling_by_process,
                publisher_topic=publisher_topic,
                publisher_endpoint_id=publisher_endpoint_id,
            )
            if process_id is None:
                process_id = sorted(graph_snapshot.processes.keys(), key=str)[0]

        process_meta = graph_snapshot.processes.get(process_id)
        if process_meta is None:
            raise RuntimeError(f"process_id '{process_id}' is not present in graph snapshot.")
        if route_unit is None:
            if not process_meta.units:
                raise RuntimeError(f"process '{process_id}' has no route units.")
            route_unit = process_meta.units[0]

        process_profile = profiling_by_process.get(process_id)
        if process_profile is None:
            raise RuntimeError(
                f"process '{process_id}' has no profiling snapshot. "
                "Make sure profiling is active for this process."
            )

        publisher_topic, publisher_endpoint_id = _select_publisher(
            process_profile,
            publisher_topic=publisher_topic,
            publisher_endpoint_id=publisher_endpoint_id,
        )
        if subscriber_topic is None:
            subscriber_topic = publisher_topic

        print("Trace alignment diagnostic")
        print(f"- graph_address: {graph_address if graph_address is not None else 'default'}")
        print(f"- process_id: {process_id}")
        print(f"- route_unit: {route_unit}")
        print(f"- publisher_topic: {publisher_topic}")
        print(f"- publisher_endpoint_id: {publisher_endpoint_id}")
        print(f"- subscriber_topic: {subscriber_topic if subscriber_topic else '(none)'}")
        print(f"- metrics: {','.join(metrics)}")
        print(
            f"- stream: interval={args.stream_interval:.3f}s, "
            f"max_samples={args.stream_max_samples}, duration={args.duration:.2f}s",
        )
        print("")

        control = ProfilingTraceControl(
            enabled=True,
            sample_mod=max(1, int(args.sample_mod)),
            publisher_topics=[publisher_topic] if publisher_topic else None,
            publisher_endpoint_ids=[publisher_endpoint_id] if publisher_endpoint_id else None,
            subscriber_topics=[subscriber_topic] if subscriber_topic else None,
            metrics=metrics,
            ttl_seconds=args.ttl_seconds,
        )
        response = await ctx.process_set_profiling_trace(
            route_unit,
            control,
            timeout=args.timeout,
        )
        if not response.ok:
            raise RuntimeError(
                f"Trace control rejected for process '{process_id}': {response.error}"
            )
        control_applied = True

        stream = ctx.subscribe_profiling_trace(
            ProfilingStreamControl(
                interval=max(0.01, float(args.stream_interval)),
                max_samples=max(1, int(args.stream_max_samples)),
                process_ids=[process_id],
                include_empty_batches=False,
            )
        )

        samples: list[CapturedSample] = []
        metric_counts: Counter[str] = Counter()
        metric_seq_missing: Counter[str] = Counter()
        batch_metric_presence: list[set[str]] = []
        batch_sizes: list[int] = []
        arrival_index = 0
        batches_seen = 0

        deadline = time.monotonic() + max(0.1, float(args.duration))
        while time.monotonic() < deadline:
            timeout_s = min(
                max(0.1, float(args.stream_interval) * 3.0),
                max(0.1, deadline - time.monotonic()),
            )
            try:
                batch = await asyncio.wait_for(anext(stream), timeout=timeout_s)
            except TimeoutError:
                continue

            process_batch = batch.batches.get(process_id)
            if process_batch is None:
                continue

            batches_seen += 1
            batch_sizes.append(len(process_batch.samples))
            present: set[str] = set()
            for sample in process_batch.samples:
                if not isinstance(sample, ProfilingTraceSample):
                    continue
                metric_counts[sample.metric] += 1
                if sample.sample_seq is None:
                    metric_seq_missing[sample.metric] += 1
                present.add(sample.metric)
                samples.append(
                    CapturedSample(
                        arrival_index=arrival_index,
                        process_id=process_id,
                        timestamp=sample.timestamp,
                        metric=sample.metric,
                        endpoint_id=sample.endpoint_id,
                        topic=sample.topic,
                        value=sample.value,
                        sample_seq=sample.sample_seq,
                    )
                )
                arrival_index += 1
            batch_metric_presence.append(present)

        publish_samples = [
            s for s in samples if s.metric == "publish_delta_ns" and s.sample_seq is not None
        ]
        lease_samples = [
            s for s in samples if s.metric == "lease_time_ns" and s.sample_seq is not None
        ]
        attr_samples = [
            s
            for s in samples
            if s.metric == "attributable_backpressure_ns" and s.sample_seq is not None
        ]

        publish_by_seq: dict[int, float] = {}
        for sample in publish_samples:
            if sample.sample_seq is None:
                continue
            publish_by_seq.setdefault(sample.sample_seq, sample.timestamp)
        publish_min_seq = min(publish_by_seq.keys()) if publish_by_seq else None
        publish_max_seq = max(publish_by_seq.keys()) if publish_by_seq else None

        lease_deltas_ms: list[float] = []
        lease_matched = 0
        lease_by_endpoint_ms: dict[str, list[float]] = defaultdict(list)
        lease_unmatched_below = 0
        lease_unmatched_above = 0
        lease_unmatched_within = 0
        for sample in lease_samples:
            seq = sample.sample_seq
            if seq is None:
                continue
            pub_ts = publish_by_seq.get(seq)
            if pub_ts is None:
                if publish_min_seq is None or publish_max_seq is None:
                    lease_unmatched_within += 1
                elif seq < publish_min_seq:
                    lease_unmatched_below += 1
                elif seq > publish_max_seq:
                    lease_unmatched_above += 1
                else:
                    lease_unmatched_within += 1
                continue
            delta_ms = (sample.timestamp - pub_ts) / 1e6
            lease_deltas_ms.append(delta_ms)
            lease_matched += 1
            lease_by_endpoint_ms[sample.endpoint_id].append(delta_ms)

        attr_deltas_ms: list[float] = []
        attr_matched = 0
        attr_by_endpoint_ms: dict[str, list[float]] = defaultdict(list)
        attr_unmatched_below = 0
        attr_unmatched_above = 0
        attr_unmatched_within = 0
        for sample in attr_samples:
            seq = sample.sample_seq
            if seq is None:
                continue
            pub_ts = publish_by_seq.get(seq)
            if pub_ts is None:
                if publish_min_seq is None or publish_max_seq is None:
                    attr_unmatched_within += 1
                elif seq < publish_min_seq:
                    attr_unmatched_below += 1
                elif seq > publish_max_seq:
                    attr_unmatched_above += 1
                else:
                    attr_unmatched_within += 1
                continue
            delta_ms = (sample.timestamp - pub_ts) / 1e6
            attr_deltas_ms.append(delta_ms)
            attr_matched += 1
            attr_by_endpoint_ms[sample.endpoint_id].append(delta_ms)

        publish_unique_seq = len({s.sample_seq for s in publish_samples if s.sample_seq is not None})
        lease_unique_seq = len({s.sample_seq for s in lease_samples if s.sample_seq is not None})
        attr_unique_seq = len({s.sample_seq for s in attr_samples if s.sample_seq is not None})
        overlap_lease = len(
            {
                s.sample_seq
                for s in lease_samples
                if s.sample_seq is not None and s.sample_seq in publish_by_seq
            }
        )
        overlap_attr = len(
            {
                s.sample_seq
                for s in attr_samples
                if s.sample_seq is not None and s.sample_seq in publish_by_seq
            }
        )

        elapsed = time.monotonic() - t0
        full_batches = sum(
            1 for size in batch_sizes if size >= max(1, int(args.stream_max_samples))
        )
        mean_batch_size = statistics.fmean(batch_sizes) if batch_sizes else 0.0
        print("Capture summary")
        print(f"- elapsed: {elapsed:.2f}s")
        print(f"- batches_seen: {batches_seen}")
        print(f"- samples_seen: {len(samples)}")
        print(
            f"- batch_size avg/full: {mean_batch_size:.1f}/"
            f"{max(1, int(args.stream_max_samples))}, "
            f"full_batches={full_batches}/{max(1, batches_seen)}",
        )
        print("")

        print("Metric counts")
        _print_metric_line("publish_delta_ns", metric_counts, metric_seq_missing)
        _print_metric_line("lease_time_ns", metric_counts, metric_seq_missing)
        _print_metric_line("attributable_backpressure_ns", metric_counts, metric_seq_missing)
        print("")

        print("Sequence overlap")
        print(f"- publish unique sample_seq: {publish_unique_seq}")
        print(
            f"- lease unique sample_seq: {lease_unique_seq} "
            f"(overlap with publish={overlap_lease})"
        )
        print(
            f"- attr unique sample_seq: {attr_unique_seq} "
            f"(overlap with publish={overlap_attr})"
        )
        print("")

        print("Timestamp alignment (subscriber_ts - publish_ts)")
        _print_delta_stats(
            "lease_time_ns",
            lease_deltas_ms,
            total=len(lease_samples),
            matched=lease_matched,
        )
        print(
            f"  unmatched split: below_publish_range={lease_unmatched_below}, "
            f"within_publish_range={lease_unmatched_within}, "
            f"above_publish_range={lease_unmatched_above}",
        )
        _print_delta_stats(
            "attributable_backpressure_ns",
            attr_deltas_ms,
            total=len(attr_samples),
            matched=attr_matched,
        )
        print(
            f"  unmatched split: below_publish_range={attr_unmatched_below}, "
            f"within_publish_range={attr_unmatched_within}, "
            f"above_publish_range={attr_unmatched_above}",
        )
        print("")

        print("Per-subscriber lease alignment")
        if lease_by_endpoint_ms:
            for endpoint_id, values in sorted(
                lease_by_endpoint_ms.items(),
                key=lambda item: len(item[1]),
                reverse=True,
            ):
                st = _stats(values)
                print(
                    f"- {endpoint_id}: n={int(st['count'])}, "
                    f"delta_ms[p50/p95/mean]={st['p50']:.4f}/{st['p95']:.4f}/{st['mean']:.4f}",
                )
        else:
            print("- no matched lease samples")
        print("")

        print("Per-batch metric starvation")
        total_batches = max(1, len(batch_metric_presence))
        for metric in [
            "publish_delta_ns",
            "lease_time_ns",
            "attributable_backpressure_ns",
        ]:
            batches_with_metric = sum(1 for present in batch_metric_presence if metric in present)
            pct = (100.0 * batches_with_metric) / total_batches
            longest_absent = _longest_absent_run(batch_metric_presence, metric)
            print(
                f"- {metric}: in {batches_with_metric}/{total_batches} batches ({pct:.1f}%), "
                f"longest_absent_run={longest_absent}",
            )

        if stream is not None:
            await stream.aclose()
            stream = None

        if control_applied and route_unit is not None:
            await ctx.process_set_profiling_trace(
                route_unit,
                ProfilingTraceControl(enabled=False),
                timeout=args.timeout,
            )
            control_applied = False

    if stream is not None:
        await stream.aclose()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Subscribe to ezmsg profiling trace stream and report sample_seq/timestamp "
            "alignment between publish and subscriber metrics."
        )
    )
    parser.add_argument(
        "--graph-address",
        default=None,
        help="Optional GraphServer address (for example: 127.0.0.1:25978).",
    )
    parser.add_argument(
        "--process-id",
        default=None,
        help="Optional target process UUID.",
    )
    parser.add_argument(
        "--unit-address",
        default=None,
        help="Optional process route unit address (if omitted, first unit of selected process).",
    )
    parser.add_argument(
        "--publisher-topic",
        default=None,
        help="Optional publisher topic filter.",
    )
    parser.add_argument(
        "--publisher-endpoint-id",
        default=None,
        help="Optional publisher endpoint_id filter.",
    )
    parser.add_argument(
        "--subscriber-topic",
        default=None,
        help="Optional subscriber topic filter. Defaults to publisher topic.",
    )
    parser.add_argument(
        "--metrics",
        default=",".join(DEFAULT_METRICS),
        help=(
            "Comma-separated metrics to request in trace control "
            "(default: publish_delta_ns,lease_time_ns,attributable_backpressure_ns)."
        ),
    )
    parser.add_argument(
        "--sample-mod",
        type=int,
        default=1,
        help="Trace sampling modulo (1 = every sample).",
    )
    parser.add_argument(
        "--ttl-seconds",
        type=float,
        default=None,
        help="Optional trace control TTL seconds.",
    )
    parser.add_argument(
        "--stream-interval",
        type=float,
        default=0.05,
        help="Profiling stream interval in seconds.",
    )
    parser.add_argument(
        "--stream-max-samples",
        type=int,
        default=1000,
        help="Max samples pulled per process per stream batch.",
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=10.0,
        help="Capture duration in seconds.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=2.0,
        help="Timeout seconds for process control/snapshot calls.",
    )
    return parser


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()
    try:
        asyncio.run(_run(args))
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
