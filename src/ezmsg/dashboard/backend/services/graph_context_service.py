from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import Mapping
from typing import Any, AsyncIterator, Callable, Protocol
from uuid import UUID

from ezmsg.core.graphcontext import GraphContext
from ezmsg.core.graphmeta import GraphSnapshot, ProfilingStreamControl, ProfilingTraceControl
from ezmsg.core.netprotocol import GRAPHSERVER_ADDR, Address

from ..json_encoding import decode_float_token
from ..models.events import (
    EventEnvelopeModel,
    ProfilingTraceEnvelope,
    SettingsChangedEnvelope,
    SystemErrorEnvelope,
    SystemHeartbeatEnvelope,
    SystemReadyEnvelope,
    TopologyChangedEnvelope,
)
from .adapters import (
    adapt_graph_snapshot,
    adapt_profiling_snapshot,
    adapt_profiling_trace_batch,
    adapt_settings_event,
    adapt_settings_snapshot,
    adapt_settings_value,
    adapt_topology_event,
)

_MISSING = object()


def _read_field_path(structured_value: Any, field_path: str) -> Any:
    """Read a dotted ``field_path`` out of a structured settings value."""
    current = structured_value
    for field_name in field_path.split("."):
        if not isinstance(current, Mapping) or field_name not in current:
            return _MISSING
        current = current[field_name]
    return current


class GraphServiceUnavailableError(RuntimeError):
    """Raised when GraphContext lifecycle service is not currently active."""


class SettingsPatchError(RuntimeError):
    """Raised when a settings patch request fails in GraphContext."""


class ProfilingTraceControlError(RuntimeError):
    """Raised when profiling trace control cannot be applied."""


class GraphServiceProtocol(Protocol):
    async def startup(self) -> None: ...

    async def shutdown(self) -> None: ...

    async def health_payload(self) -> dict[str, Any]: ...

    async def snapshot_payload(self) -> dict[str, Any]: ...

    async def settings_payload(self) -> dict[str, Any]: ...

    async def update_setting_field(
        self,
        *,
        component_address: str,
        field_path: str,
        value: Any,
        timeout: float,
    ) -> dict[str, Any]: ...

    async def set_profiling_trace_control(
        self,
        *,
        process_id: str,
        enabled: bool,
        publisher_endpoint_id: str | None,
        publisher_topic: str | None,
        subscriber_topic: str | None,
        metrics: list[str] | None,
        sample_mod: int,
        ttl_seconds: float | None,
        timeout: float,
    ) -> dict[str, Any]: ...

    async def event_envelopes(
        self,
        *,
        topology_after_seq: int,
        settings_after_seq: int,
        profiling_interval: float,
        profiling_max_samples: int,
    ) -> AsyncIterator[dict[str, Any]]: ...


class GraphContextLifecycleService:
    def __init__(
        self,
        *,
        graph_address: Any = None,
        auto_start: bool | None = None,
        heartbeat_seconds: float = 10.0,
        queue_size: int = 512,
        graph_context_factory: Callable[..., GraphContext] = GraphContext,
    ) -> None:
        self._graph_address = graph_address
        self._auto_start = auto_start
        self._heartbeat_seconds = heartbeat_seconds
        self._queue_size = queue_size
        self._graph_context_factory = graph_context_factory
        self._startup_lock = asyncio.Lock()
        self._shutdown_lock = asyncio.Lock()
        self._context: GraphContext | None = None
        self._active_trace_route_units: set[str] = set()

    def _graph_context_address(self) -> Address | None:
        if self._graph_address is None:
            return None
        if isinstance(self._graph_address, Address):
            return self._graph_address
        return Address.from_string(str(self._graph_address))

    @property
    def is_started(self) -> bool:
        return self._context is not None

    async def startup(self) -> None:
        async with self._startup_lock:
            if self._context is not None:
                return
            context = self._graph_context_factory(
                graph_address=self._graph_context_address(),
                auto_start=self._auto_start,
            )
            await context.__aenter__()
            self._context = context

    async def shutdown(self) -> None:
        async with self._shutdown_lock:
            context = self._context
            if context is None:
                return
            self._context = None
            self._active_trace_route_units.clear()
            await context.__aexit__(None, None, None)

    def _require_context(self) -> GraphContext:
        if self._context is None:
            raise GraphServiceUnavailableError("GraphContext is not active.")
        return self._context

    def _effective_graph_address(self) -> str:
        context = self._context
        if context is not None and getattr(context, "graph_address", None) is not None:
            return str(context.graph_address)
        if self._graph_address is not None:
            return str(self._graph_address)
        return str(GRAPHSERVER_ADDR)

    async def health_payload(self) -> dict[str, Any]:
        context = self._context
        return {
            "status": "ok",
            "graph_session_active": context is not None,
            "graph_address": self._effective_graph_address(),
        }

    async def snapshot_payload(self) -> dict[str, Any]:
        context = self._require_context()
        graph_snapshot, settings_snapshot, profiling_snapshot = await asyncio.gather(
            context.snapshot(),
            context.settings_snapshot(),
            context.profiling_snapshot_all(),
        )
        settings_with_patchability = self._settings_with_patchability(
            settings_snapshot=settings_snapshot,
            graph_snapshot=graph_snapshot,
        )
        return {
            "snapshot": adapt_graph_snapshot(graph_snapshot),
            "settings": settings_with_patchability,
            "profiling": adapt_profiling_snapshot(profiling_snapshot),
        }

    async def settings_payload(self) -> dict[str, Any]:
        context = self._require_context()
        settings_snapshot, graph_snapshot = await asyncio.gather(
            context.settings_snapshot(),
            context.snapshot(),
        )
        settings_with_patchability = self._settings_with_patchability(
            settings_snapshot=settings_snapshot,
            graph_snapshot=graph_snapshot,
        )
        return {"settings": settings_with_patchability}

    async def update_setting_field(
        self,
        *,
        component_address: str,
        field_path: str,
        value: Any,
        timeout: float = 2.0,
    ) -> dict[str, Any]:
        context = self._require_context()
        graph_snapshot = await context.snapshot()
        if not self._component_is_patchable(graph_snapshot, component_address):
            raise SettingsPatchError(f"Component '{component_address}' does not support dynamic settings patches.")
        patch_value = await self._decoded_patch_value(
            context=context,
            component_address=component_address,
            field_path=field_path,
            value=value,
        )
        try:
            updated_value = await context.update_setting(
                component_address=component_address,
                field_path=field_path,
                value=patch_value,
                timeout=timeout,
            )
        except Exception as exc:
            raise SettingsPatchError(str(exc)) from exc

        return {
            "component_address": component_address,
            "field_path": field_path,
            "updated_value": adapt_settings_value(updated_value),
        }

    async def _decoded_patch_value(
        self,
        *,
        context: GraphContext,
        component_address: str,
        field_path: str,
        value: Any,
    ) -> Any:
        """Turn a non-finite token back into the float it stands for.

        The wire encoding is a string (JSON has no ``inf`` literal), so a patch
        must be decoded before it reaches ezmsg -- which writes the value into
        the dataclass as-is and would otherwise leave a ``str`` in a ``float``
        field. Only fields that currently hold a number are decoded; anything
        else is rejected rather than silently rewritten.
        """
        decoded = decode_float_token(value)
        if decoded is None:
            return value

        settings_snapshot = await context.settings_snapshot()
        snapshot_value = settings_snapshot.get(component_address)
        current = _MISSING
        if snapshot_value is not None:
            structured = snapshot_value.structured_value
            if structured is None and isinstance(snapshot_value.repr_value, Mapping):
                structured = snapshot_value.repr_value
            current = _read_field_path(structured, field_path)

        if isinstance(current, (int, float)) and not isinstance(current, bool):
            return decoded

        raise SettingsPatchError(
            f"Cannot apply non-finite value '{value}' to "
            f"'{component_address}.{field_path}': the field does not currently hold a number"
            + ("." if current is _MISSING else f" (current value: {current!r}).")
        )

    async def set_profiling_trace_control(
        self,
        *,
        process_id: str,
        enabled: bool,
        publisher_endpoint_id: str | None,
        publisher_topic: str | None,
        subscriber_topic: str | None,
        metrics: list[str] | None,
        sample_mod: int = 1,
        ttl_seconds: float | None = None,
        timeout: float = 2.0,
    ) -> dict[str, Any]:
        context = self._require_context()
        graph_snapshot = await context.snapshot()

        try:
            process_uuid = UUID(process_id)
        except ValueError as exc:
            raise ProfilingTraceControlError(f"Invalid process_id '{process_id}'.") from exc

        process_meta = graph_snapshot.processes.get(process_uuid)
        if process_meta is None:
            raise ProfilingTraceControlError(f"Process '{process_id}' is not present in the graph snapshot.")
        if len(process_meta.units) == 0:
            raise ProfilingTraceControlError(f"Process '{process_id}' has no routable units for control requests.")

        route_unit = process_meta.units[0]
        normalized_sample_mod = max(1, int(sample_mod))

        if not enabled:
            targets = set(self._active_trace_route_units)
            if len(targets) == 0:
                targets = {route_unit}
            await self._apply_disable_trace_controls(
                context=context,
                route_units=targets,
                sample_mod=normalized_sample_mod,
                timeout=timeout,
            )
            self._active_trace_route_units.clear()
            return {
                "process_id": process_id,
                "unit_address": route_unit,
                "unit_addresses": sorted(targets),
                "enabled": False,
                "control": {
                    "sample_mod": normalized_sample_mod,
                    "publisher_topics": [],
                    "subscriber_topics": [],
                    "publisher_endpoint_ids": [],
                    "metrics": [],
                    "ttl_seconds": ttl_seconds,
                },
            }

        # Keep at most one active dashboard trace scope at a time across processes.
        if len(self._active_trace_route_units) > 0:
            await self._apply_disable_trace_controls(
                context=context,
                route_units=set(self._active_trace_route_units),
                sample_mod=normalized_sample_mod,
                timeout=timeout,
            )
            self._active_trace_route_units.clear()

        publisher_control = ProfilingTraceControl(
            enabled=True,
            sample_mod=normalized_sample_mod,
            publisher_topics=[publisher_topic] if publisher_topic else None,
            subscriber_topics=[subscriber_topic] if subscriber_topic else None,
            publisher_endpoint_ids=[publisher_endpoint_id] if publisher_endpoint_id else None,
            metrics=metrics if metrics else None,
            ttl_seconds=ttl_seconds,
        )

        controls_by_route_unit: dict[str, ProfilingTraceControl] = {route_unit: publisher_control}

        subscriber_metrics = self._subscriber_trace_metrics(metrics)
        subscriber_seed_topic = subscriber_topic or publisher_topic
        if subscriber_seed_topic and len(subscriber_metrics) > 0:
            candidate_topic_scope = self._topic_scope_for_seed(
                graph_snapshot=graph_snapshot,
                seed_topic=subscriber_seed_topic,
            )
            profiling_snapshot = await context.profiling_snapshot_all(timeout_per_process=timeout)
            route_units_for_subscribers = self._route_units_with_subscribers_for_scope(
                graph_snapshot=graph_snapshot,
                profiling_snapshot=profiling_snapshot,
                topic_scope=candidate_topic_scope,
            )
            route_units_for_subscribers.discard(route_unit)
            for subscriber_route_unit in route_units_for_subscribers:
                controls_by_route_unit[subscriber_route_unit] = ProfilingTraceControl(
                    enabled=True,
                    sample_mod=normalized_sample_mod,
                    publisher_topics=None,
                    subscriber_topics=sorted(candidate_topic_scope),
                    publisher_endpoint_ids=None,
                    metrics=subscriber_metrics,
                    ttl_seconds=ttl_seconds,
                )

        for target_route_unit, control in controls_by_route_unit.items():
            try:
                response = await context.process_set_profiling_trace(
                    target_route_unit,
                    control,
                    timeout=timeout,
                )
            except Exception as exc:
                raise ProfilingTraceControlError(str(exc)) from exc

            if not response.ok:
                raise ProfilingTraceControlError(f"Process trace control rejected for '{process_id}': {response.error}")

        self._active_trace_route_units = set(controls_by_route_unit.keys())
        return {
            "process_id": process_id,
            "unit_address": route_unit,
            "unit_addresses": sorted(controls_by_route_unit.keys()),
            "enabled": True,
            "control": {
                "sample_mod": normalized_sample_mod,
                "publisher_topics": publisher_control.publisher_topics,
                "subscriber_topics": publisher_control.subscriber_topics,
                "publisher_endpoint_ids": publisher_control.publisher_endpoint_ids,
                "metrics": publisher_control.metrics,
                "ttl_seconds": publisher_control.ttl_seconds,
            },
            "subscriber_scope": {
                "seed_topic": subscriber_seed_topic,
                "route_units": sorted(unit for unit in controls_by_route_unit.keys() if unit != route_unit),
                "metrics": subscriber_metrics,
            },
        }

    async def _apply_disable_trace_controls(
        self,
        *,
        context: GraphContext,
        route_units: set[str],
        sample_mod: int,
        timeout: float,
    ) -> None:
        disable_control = ProfilingTraceControl(
            enabled=False,
            sample_mod=sample_mod,
            publisher_topics=None,
            subscriber_topics=None,
            publisher_endpoint_ids=None,
            metrics=None,
            ttl_seconds=None,
        )
        for target_route_unit in route_units:
            try:
                await context.process_set_profiling_trace(
                    target_route_unit,
                    disable_control,
                    timeout=timeout,
                )
            except Exception:
                continue

    def _subscriber_trace_metrics(self, metrics: list[str] | None) -> list[str]:
        allowed = {"lease_time_ns", "user_span_ns"}
        if metrics is None:
            return ["lease_time_ns", "user_span_ns"]
        return [metric for metric in metrics if metric in allowed]

    def _topic_scope_for_seed(
        self,
        *,
        graph_snapshot: GraphSnapshot,
        seed_topic: str,
    ) -> set[str]:
        out: set[str] = {seed_topic}
        routed_topics = graph_snapshot.graph.get(seed_topic, [])
        for routed_topic in routed_topics:
            if isinstance(routed_topic, str):
                out.add(routed_topic)
        return out

    def _route_units_with_subscribers_for_scope(
        self,
        *,
        graph_snapshot: GraphSnapshot,
        profiling_snapshot: dict[UUID, Any],
        topic_scope: set[str],
    ) -> set[str]:
        route_units: set[str] = set()
        for process_uuid, process_profile in profiling_snapshot.items():
            process_meta = graph_snapshot.processes.get(process_uuid)
            if process_meta is None or len(process_meta.units) == 0:
                continue
            subscribers = getattr(process_profile, "subscribers", {})
            for subscriber in subscribers.values():
                topic = getattr(subscriber, "topic", None)
                if not isinstance(topic, str):
                    continue
                if self._topic_matches_scope(topic, topic_scope):
                    route_units.add(process_meta.units[0])
                    break
        return route_units

    def _topic_matches_scope(self, topic: str, topic_scope: set[str]) -> bool:
        if topic in topic_scope:
            return True
        for scope_topic in topic_scope:
            if topic.startswith(f"{scope_topic}:"):
                return True
        return False

    def _settings_with_patchability(
        self,
        *,
        settings_snapshot: dict[str, Any],
        graph_snapshot: GraphSnapshot,
    ) -> dict[str, dict[str, Any]]:
        component_info = self._component_info_by_component(graph_snapshot)
        adapted = adapt_settings_snapshot(settings_snapshot)
        out: dict[str, dict[str, Any]] = {}
        for component_address, value in adapted.items():
            info = component_info.get(
                component_address,
                {
                    "patchable": False,
                    "component_type": None,
                    "component_name": None,
                },
            )
            patchable = bool(info["patchable"])
            out[component_address] = {
                **value,
                "patchable": patchable,
                "patch_error": (None if patchable else "Read-only: component does not expose dynamic settings."),
                "component_type": info["component_type"],
                "component_name": info["component_name"],
            }
        return out

    def _component_is_patchable(
        self,
        graph_snapshot: GraphSnapshot,
        component_address: str,
    ) -> bool:
        return bool(
            self._component_info_by_component(graph_snapshot).get(component_address, {"patchable": False})["patchable"]
        )

    def _component_info_by_component(
        self,
        graph_snapshot: GraphSnapshot,
    ) -> dict[str, dict[str, Any]]:
        component_info: dict[str, dict[str, Any]] = {}
        for session in graph_snapshot.sessions.values():
            metadata = session.metadata
            if metadata is None:
                continue
            for component_address, component in metadata.components.items():
                dynamic_settings = getattr(component, "dynamic_settings", None)
                enabled = bool(dynamic_settings is not None and getattr(dynamic_settings, "enabled", False))
                existing = component_info.get(
                    component_address,
                    {
                        "patchable": False,
                        "component_type": None,
                        "component_name": None,
                    },
                )
                component_info[component_address] = {
                    "patchable": bool(existing["patchable"]) or enabled,
                    "component_type": existing["component_type"] or getattr(component, "component_type", None),
                    "component_name": existing["component_name"] or getattr(component, "name", None),
                }
        return component_info

    async def event_envelopes(
        self,
        *,
        topology_after_seq: int = 0,
        settings_after_seq: int = 0,
        profiling_interval: float = 0.05,
        profiling_max_samples: int = 5000,
    ) -> AsyncIterator[dict[str, Any]]:
        context = self._require_context()
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=self._queue_size)

        async def enqueue(item: EventEnvelopeModel) -> None:
            payload = item.model_dump(mode="json")
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
                queue.put_nowait(payload)

        async def topology_worker() -> None:
            try:
                async for event in context.subscribe_topology_events(after_seq=topology_after_seq):
                    await enqueue(
                        TopologyChangedEnvelope(
                            kind="topology.changed",
                            data=adapt_topology_event(event),
                        )
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await enqueue_error(f"topology stream stopped: {exc}")

        async def settings_worker() -> None:
            try:
                async for event in context.subscribe_settings_events(after_seq=settings_after_seq):
                    await enqueue(
                        SettingsChangedEnvelope(
                            kind="settings.changed",
                            data=adapt_settings_event(event),
                        )
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await enqueue_error(f"settings stream stopped: {exc}")

        async def profiling_worker() -> None:
            control = ProfilingStreamControl(
                interval=profiling_interval,
                max_samples=profiling_max_samples,
            )
            try:
                async for batch in context.subscribe_profiling_trace(control):
                    await enqueue(
                        ProfilingTraceEnvelope(
                            kind="profiling.trace",
                            data=adapt_profiling_trace_batch(batch),
                        )
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await enqueue_error(f"profiling stream stopped: {exc}")

        async def enqueue_error(message: str) -> None:
            await enqueue(
                SystemErrorEnvelope(
                    kind="system.error",
                    data={"timestamp": time.time(), "message": message},
                )
            )

        workers = [
            asyncio.create_task(topology_worker(), name="dashboard-topology-events"),
            asyncio.create_task(settings_worker(), name="dashboard-settings-events"),
            asyncio.create_task(profiling_worker(), name="dashboard-profiling-events"),
        ]

        try:
            yield SystemReadyEnvelope(
                kind="system.ready",
                data={
                    "timestamp": time.time(),
                    "message": "Subscriptions active.",
                },
            ).model_dump(mode="json")

            while True:
                try:
                    message = await asyncio.wait_for(
                        queue.get(),
                        timeout=self._heartbeat_seconds,
                    )
                    yield message
                except TimeoutError:
                    heartbeat = SystemHeartbeatEnvelope(
                        kind="system.heartbeat",
                        data={"timestamp": time.time()},
                    )
                    yield heartbeat.model_dump(mode="json")
        finally:
            for worker in workers:
                worker.cancel()
            for worker in workers:
                with contextlib.suppress(asyncio.CancelledError):
                    await worker
