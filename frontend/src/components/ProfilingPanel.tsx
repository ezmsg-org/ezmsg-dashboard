import { useEffect, useMemo, useState } from "react";

import { Panel } from "./Panel";
import { TraceTimingPanel, type TimingTraceSample } from "./TraceTimingPanel";
import type {
  ProfilingTraceControlRequest,
  ProcessProfilingSnapshotPayload,
  ProfilingSnapshotPayload,
  PublisherProfilingSnapshot,
  SubscriberProfilingSnapshot,
} from "../types/api";
import type { ProfilingTraceEnvelope } from "../types/events";

type ProfilingPanelProps = {
  profilingSnapshot: ProfilingSnapshotPayload | null;
  latestTraceEvent: ProfilingTraceEnvelope | null;
  setProfilingTraceControl: (
    request: ProfilingTraceControlRequest
  ) => Promise<unknown>;
};

type Severity = "none" | "low" | "medium" | "high";

type SubscriberContributor = {
  id: string;
  endpointId: string;
  topic: string;
  processId: string;
  pid: number;
  host: string;
  messagesWindow: number;
  attributableBackpressureNsWindow: number;
  attributableBackpressureEvents: number;
  userSpanNsAvgWindow: number;
};

type PublisherRow = {
  id: string;
  endpointId: string;
  topic: string;
  processId: string;
  pid: number;
  host: string;
  windowSeconds: number;
  publishRateHzWindow: number;
  messagesPublishedWindow: number;
  publishDeltaNsAvgWindow: number;
  inflightCurrent: number;
  inflightDisplayTotal: number;
  backpressureNsWindow: number;
  severity: Severity;
  contributors: SubscriberContributor[];
};

type PublisherTraceSample = {
  rowId: string;
  processId: string;
  endpointId: string;
  topic: string;
  timestamp: number;
  metric: string;
  value: number;
  sampleSeq: number | null;
  channelKind: string | null;
};

const TRACE_HISTORY_MAX = 800;
const TRACE_PUBLISHER_METRICS = new Set(["publish_delta_ns", "backpressure_wait_ns"]);
const TRACE_SUBSCRIBER_METRICS = new Set([
  "lease_time_ns",
  "attributable_backpressure_ns",
  "user_span_ns",
]);

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nsToMs(ns: number): number {
  return ns / 1_000_000;
}

function formatRate(hz: number): string {
  return `${hz.toFixed(1)} Hz`;
}

function formatMs(ns: number): string {
  return `${nsToMs(ns).toFixed(2)} ms`;
}

function formatWindowSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  if (Math.abs(seconds - Math.round(seconds)) < 1e-6) {
    return `${Math.round(seconds)}s`;
  }
  return `${seconds.toFixed(1)}s`;
}

function shortEndpointToken(endpointId: string): string {
  const parts = endpointId.split(":");
  const last = parts.length > 0 ? parts[parts.length - 1] : endpointId;
  if (last.length >= 8) {
    return last.slice(0, 8);
  }
  return endpointId.slice(0, 8);
}

function shortTopic(topic: string, max = 48): string {
  if (topic.length <= max) {
    return topic;
  }
  return `${topic.slice(0, max - 1)}…`;
}

function backpressureSeverity(backpressureNsWindow: number): Severity {
  if (backpressureNsWindow <= 0) {
    return "none";
  }
  if (backpressureNsWindow < 1_000_000) {
    return "low";
  }
  if (backpressureNsWindow < 20_000_000) {
    return "medium";
  }
  return "high";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractTraceSamples(
  event: ProfilingTraceEnvelope | null
): PublisherTraceSample[] {
  if (!event) {
    return [];
  }
  const out: PublisherTraceSample[] = [];
  for (const [processId, processBatch] of Object.entries(event.data.batches)) {
    if (!isRecord(processBatch)) {
      continue;
    }
    const samples = processBatch.samples;
    if (!Array.isArray(samples)) {
      continue;
    }
    for (const sample of samples) {
      if (!isRecord(sample)) {
        continue;
      }
      const endpointId = sample.endpoint_id;
      const topic = sample.topic;
      const metric = sample.metric;
      const value = sample.value;
      const timestamp = sample.timestamp;
      const sampleSeq = sample.sample_seq;
      if (
        typeof endpointId !== "string"
        || typeof topic !== "string"
        || typeof metric !== "string"
        || typeof value !== "number"
        || !Number.isFinite(value)
      ) {
        continue;
      }
      out.push({
        rowId: `${processId}:${endpointId}`,
        processId,
        endpointId,
        topic,
        timestamp:
          typeof timestamp === "number" && Number.isFinite(timestamp)
            ? timestamp
            : event.data.timestamp,
        metric,
        value,
        sampleSeq:
          typeof sampleSeq === "number" && Number.isFinite(sampleSeq)
            ? Math.trunc(sampleSeq)
            : null,
        channelKind:
          typeof sample.channel_kind === "string" ? sample.channel_kind : null,
      });
    }
  }
  return out;
}

function toContributor(
  process: ProcessProfilingSnapshotPayload,
  subscriber: SubscriberProfilingSnapshot
): SubscriberContributor {
  return {
    id: `${process.process_id}:${subscriber.endpoint_id}`,
    endpointId: subscriber.endpoint_id,
    topic: subscriber.topic,
    processId: process.process_id,
    pid: process.pid,
    host: process.host,
    messagesWindow: toNumber(subscriber.messages_received_window),
    attributableBackpressureNsWindow: toNumber(
      subscriber.attributable_backpressure_ns_window
    ),
    attributableBackpressureEvents: toNumber(
      subscriber.attributable_backpressure_events_total
    ),
    userSpanNsAvgWindow: toNumber(subscriber.user_span_ns_avg_window),
  };
}

function contributorListForPublisher(
  topic: string,
  subscribers: SubscriberContributor[]
): SubscriberContributor[] {
  return subscribers
    .filter((subscriber) => subscriber.topic === topic)
    .sort(
      (a, b) =>
        b.attributableBackpressureNsWindow - a.attributableBackpressureNsWindow
    );
}

function toPublisherRow(
  process: ProcessProfilingSnapshotPayload,
  publisher: PublisherProfilingSnapshot,
  allSubscribers: SubscriberContributor[]
): PublisherRow {
  const backpressureNsWindow = toNumber(publisher.backpressure_wait_ns_window);
  const severity = backpressureSeverity(backpressureNsWindow);
  const rowId = `${process.process_id}:${publisher.endpoint_id}`;
  const rawNumBuffers = publisher["num_buffers"];
  const numBuffers =
    typeof rawNumBuffers === "number" && Number.isFinite(rawNumBuffers)
      ? Math.max(0, Math.trunc(rawNumBuffers))
      : null;
  const inflightPeakWindow = toNumber(publisher.inflight_messages_peak_window);
  return {
    id: rowId,
    endpointId: publisher.endpoint_id,
    topic: publisher.topic,
    processId: process.process_id,
    pid: process.pid,
    host: process.host,
    windowSeconds: toNumber(process.window_seconds),
    publishRateHzWindow: toNumber(publisher.publish_rate_hz_window),
    messagesPublishedWindow: toNumber(publisher.messages_published_window),
    publishDeltaNsAvgWindow: toNumber(publisher.publish_delta_ns_avg_window),
    inflightCurrent: toNumber(publisher.inflight_messages_current),
    inflightDisplayTotal: numBuffers ?? inflightPeakWindow,
    backpressureNsWindow,
    severity,
    contributors: contributorListForPublisher(publisher.topic, allSubscribers),
  };
}

export function ProfilingPanel({
  profilingSnapshot,
  latestTraceEvent,
  setProfilingTraceControl,
}: ProfilingPanelProps) {
  const [searchText, setSearchText] = useState("");
  const [pressuredOnly, setPressuredOnly] = useState(false);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [activeTraceRowIds, setActiveTraceRowIds] = useState<string[]>([]);
  const [traceSamplesByRowId, setTraceSamplesByRowId] = useState<
    Record<string, PublisherTraceSample[]>
  >({});
  const [traceControlPending, setTraceControlPending] = useState<
    Record<string, boolean>
  >({});
  const [traceControlError, setTraceControlError] = useState<
    Record<string, string | null>
  >({});

  const processRows = useMemo(
    () => (profilingSnapshot ? Object.values(profilingSnapshot) : []),
    [profilingSnapshot]
  );

  const publisherRows = useMemo(() => {
    const allSubscribers: SubscriberContributor[] = [];
    for (const process of processRows) {
      for (const subscriber of Object.values(process.subscribers)) {
        allSubscribers.push(toContributor(process, subscriber));
      }
    }

    const rows: PublisherRow[] = [];
    for (const process of processRows) {
      for (const publisher of Object.values(process.publishers)) {
        rows.push(toPublisherRow(process, publisher, allSubscribers));
      }
    }

    return rows.sort((a, b) => b.backpressureNsWindow - a.backpressureNsWindow);
  }, [processRows]);

  const filteredRows = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return publisherRows.filter((row) => {
      if (pressuredOnly && row.backpressureNsWindow <= 0) {
        return false;
      }
      if (query.length === 0) {
        return true;
      }
      return (
        row.topic.toLowerCase().includes(query)
        || row.endpointId.toLowerCase().includes(query)
        || row.processId.toLowerCase().includes(query)
      );
    });
  }, [publisherRows, pressuredOnly, searchText]);

  const rowById = useMemo(
    () => new Map(publisherRows.map((row) => [row.id, row])),
    [publisherRows]
  );

  useEffect(() => {
    if (!latestTraceEvent || activeTraceRowIds.length === 0) {
      return;
    }
    const extracted = extractTraceSamples(latestTraceEvent);
    if (extracted.length === 0) {
      return;
    }
    const activeIds = new Set(activeTraceRowIds);
    const activeRows = activeTraceRowIds
      .map((rowId) => rowById.get(rowId))
      .filter((row): row is PublisherRow => row !== undefined);
    setTraceSamplesByRowId((previous) => {
      let changed = false;
      const next: Record<string, PublisherTraceSample[]> = { ...previous };
      for (const sample of extracted) {
        const matchedRowIds = new Set<string>();
        const publisherRow = rowById.get(sample.rowId);
        if (
          publisherRow
          && activeIds.has(sample.rowId)
          && publisherRow.topic === sample.topic
          && TRACE_PUBLISHER_METRICS.has(sample.metric)
        ) {
          matchedRowIds.add(sample.rowId);
        }
        if (TRACE_SUBSCRIBER_METRICS.has(sample.metric)) {
          for (const activeRow of activeRows) {
            if (activeRow.topic === sample.topic) {
              matchedRowIds.add(activeRow.id);
            }
          }
        }
        for (const rowId of matchedRowIds) {
          const priorSamples = next[rowId] ?? [];
          const merged = [...priorSamples, sample];
          if (merged.length > TRACE_HISTORY_MAX) {
            merged.splice(0, merged.length - TRACE_HISTORY_MAX);
          }
          next[rowId] = merged;
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [activeTraceRowIds, latestTraceEvent, rowById]);

  const applyTraceControl = async (
    row: PublisherRow,
    nextOpen: boolean
  ): Promise<void> => {
    if (traceControlPending[row.id]) {
      return;
    }
    setTraceControlPending((previous) => ({ ...previous, [row.id]: true }));
    setTraceControlError((previous) => ({ ...previous, [row.id]: null }));
    if (nextOpen) {
      setTraceSamplesByRowId((previous) => ({ ...previous, [row.id]: [] }));
      setActiveTraceRowIds((previous) =>
        previous.includes(row.id) ? previous : [...previous, row.id]
      );
    } else {
      setActiveTraceRowIds((previous) =>
        previous.includes(row.id)
          ? previous.filter((existingId) => existingId !== row.id)
          : previous
      );
    }
    try {
      await setProfilingTraceControl({
        process_id: row.processId,
        enabled: nextOpen,
        publisher_endpoint_id: row.endpointId,
        publisher_topic: row.topic,
        subscriber_topic: row.topic,
        metrics: nextOpen
          ? [
              "publish_delta_ns",
              "lease_time_ns",
              "attributable_backpressure_ns",
              "user_span_ns",
            ]
          : null,
        sample_mod: 1,
        ttl_seconds: nextOpen ? 45.0 : null,
        timeout: 2.0,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Trace control request failed.";
      setTraceControlError((previous) => ({ ...previous, [row.id]: message }));
      setActiveTraceRowIds((previous) =>
        nextOpen
          ? previous.filter((existingId) => existingId !== row.id)
          : previous.includes(row.id)
            ? previous
            : [...previous, row.id]
      );
    } finally {
      setTraceControlPending((previous) => ({ ...previous, [row.id]: false }));
    }
  };

  const toggleExpanded = (row: PublisherRow) => {
    const nextExpanded = !expandedIds.includes(row.id);
    setExpandedIds((previous) =>
      previous.includes(row.id)
        ? previous.filter((existingId) => existingId !== row.id)
        : [...previous, row.id]
    );
    if (!nextExpanded && activeTraceRowIds.includes(row.id)) {
      void applyTraceControl(row, false);
    }
  };

  const toggleTraceCapture = (row: PublisherRow, nextOpen: boolean) => {
    void applyTraceControl(row, nextOpen);
  };

  return (
    <Panel
      title="Profiling"
      subtitle="Publisher-first backpressure diagnostics"
    >
      <div className="profiling-controls">
        <input
          type="search"
          placeholder="Search topic, endpoint, or process"
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
        />
        <button
          type="button"
          className={`toggle-btn ${pressuredOnly ? "is-active" : ""}`}
          onClick={() => setPressuredOnly((value) => !value)}
        >
          {pressuredOnly ? "Pressured Only" : "All Publishers"}
        </button>
      </div>

      {filteredRows.length === 0 ? (
        <div className="panel-section">
          <p className="muted">No publishers match the current filter.</p>
        </div>
      ) : (
        <div className="publisher-list">
          {filteredRows.map((row) => {
            const expanded = expandedIds.includes(row.id);
            const traceOpen = activeTraceRowIds.includes(row.id);
            const traceSamples = traceSamplesByRowId[row.id] ?? [];
            const traceBusy = Boolean(traceControlPending[row.id]);
            const traceErrorMessage = traceControlError[row.id] ?? null;
            const windowLabel = formatWindowSeconds(row.windowSeconds);
            return (
              <article
                key={row.id}
                className={`publisher-row severity-${row.severity}`}
              >
                <button
                  type="button"
                  className="publisher-row__toggle"
                  onClick={() => toggleExpanded(row)}
                  aria-expanded={expanded}
                >
                  <div className="publisher-row__top">
                    <div className="publisher-row__identity">
                      <span className={`severity-dot severity-${row.severity}`} />
                      <div className="publisher-row__identity-text">
                        <p className="mono publisher-topic" title={row.topic}>
                          {row.topic}
                        </p>
                        <p
                          className="muted mono publisher-subline"
                          title={`endpoint ${row.endpointId} · process ${row.processId} · pid ${row.pid}`}
                        >
                          endpoint {shortEndpointToken(row.endpointId)} · process{" "}
                          {row.processId.slice(0, 8)} · pid {row.pid}
                        </p>
                      </div>
                    </div>
                    <span className="publisher-caret">{expanded ? "▾" : "▸"}</span>
                  </div>

                  <div className="publisher-row__metrics">
                    <div>
                      <span>Rate</span>
                      <strong>{formatRate(row.publishRateHzWindow)}</strong>
                    </div>
                    <div>
                      <span>Backpressure</span>
                      <strong>{formatMs(row.backpressureNsWindow)}</strong>
                    </div>
                    <div>
                      <span>Inflight</span>
                      <strong>
                        {row.inflightCurrent} / {row.inflightDisplayTotal}
                      </strong>
                    </div>
                  </div>
                </button>

                {expanded ? (
                  <div className="publisher-row__details">
                    <div className="publisher-kpis">
                      <article className="mini-kpi">
                        <span>{windowLabel ? `Messages (${windowLabel})` : "Messages"}</span>
                        <strong>{row.messagesPublishedWindow}</strong>
                      </article>
                      <article className="mini-kpi">
                        <span>Publish Delta Avg</span>
                        <strong>{formatMs(row.publishDeltaNsAvgWindow)}</strong>
                      </article>
                      <article className="mini-kpi">
                        <span>Host</span>
                        <strong>{row.host}</strong>
                      </article>
                    </div>
                    <div className="publisher-detail-line">
                      <div className="publisher-endpoint">
                        <span>Endpoint</span>
                        <code className="mono" title={row.endpointId}>
                          {row.endpointId}
                        </code>
                      </div>
                    </div>
                    <details
                      className="trace-inline"
                      open={traceOpen}
                      onToggle={(event) =>
                        toggleTraceCapture(
                          row,
                          (event.currentTarget as HTMLDetailsElement).open
                        )
                      }
                    >
                      <summary>
                        <span>Realtime Trace</span>
                        <span className={`trace-status ${traceOpen ? "is-live" : ""}`}>
                          {traceBusy
                            ? "applying..."
                            : traceOpen
                              ? "capturing"
                              : "stopped"}
                        </span>
                      </summary>
                      <div className="trace-inline__panel">
                        {traceSamples.length === 0 ? (
                          <p className="muted">
                            Waiting for trace samples on this publisher endpoint.
                          </p>
                        ) : (
                          <>
                            <p className="trace-inline__meta">
                              {traceSamples.length} samples captured over {windowLabel || "window"}.
                            </p>
                            <TraceTimingPanel
                              samples={traceSamples as TimingTraceSample[]}
                              publisherProcessId={row.processId}
                              publisherEndpointId={row.endpointId}
                              topic={row.topic}
                              windowSeconds={2.0}
                            />
                          </>
                        )}
                        {traceErrorMessage ? (
                          <p className="patch-status err">{traceErrorMessage}</p>
                        ) : null}
                      </div>
                    </details>

                    <div className="panel-section">
                      <h3>Subscribers</h3>
                      {row.contributors.length === 0 ? (
                        <p className="muted">
                          No subscriber profiling data is available for this topic.
                        </p>
                      ) : (
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Topic</th>
                              <th>Process</th>
                              <th>Attr. Backpressure</th>
                              <th>Backpressure Events</th>
                              <th>Msgs In (window)</th>
                              <th>User Span Avg</th>
                            </tr>
                          </thead>
                          <tbody>
                            {row.contributors.map((contributor) => (
                              <tr key={contributor.id}>
                                <td>
                                  <details className="topic-details">
                                    <summary
                                      className="mono topic-summary"
                                      title={`endpoint ${contributor.endpointId}`}
                                    >
                                      {shortTopic(contributor.topic)}
                                    </summary>
                                    <div className="mono topic-full">
                                      {contributor.topic}
                                    </div>
                                  </details>
                                </td>
                                <td className="mono">
                                  {contributor.processId.slice(0, 8)} (pid {contributor.pid})
                                </td>
                                <td>{formatMs(contributor.attributableBackpressureNsWindow)}</td>
                                <td>{contributor.attributableBackpressureEvents}</td>
                                <td>{contributor.messagesWindow}</td>
                                <td>{formatMs(contributor.userSpanNsAvgWindow)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
