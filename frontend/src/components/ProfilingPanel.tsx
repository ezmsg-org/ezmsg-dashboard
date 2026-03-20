import { useEffect, useMemo, useState } from "react";

import { Panel } from "./Panel";
import { TraceTimingPanel, type TimingTraceSample } from "./TraceTimingPanel";
import { buildLeaseColorMap, leaseColorForEndpoint } from "../utils/traceColors";
import type {
  GraphSnapshotPayload,
  ProfilingTraceControlRequest,
  ProcessProfilingSnapshotPayload,
  ProfilingSnapshotPayload,
  PublisherProfilingSnapshot,
  SubscriberProfilingSnapshot,
} from "../types/api";
import type { ProfilingTraceEnvelope } from "../types/events";

type ProfilingPanelProps = {
  graphSnapshot: GraphSnapshotPayload | null;
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

const TRACE_DEFAULT_WINDOW_SECONDS = 2.0;
const TRACE_WINDOW_MIN_SECONDS = 0.5;
const TRACE_WINDOW_MAX_SECONDS = 30.0;
const TRACE_PUBLISHER_METRICS = new Set(["publish_delta_ns", "backpressure_wait_ns"]);
const TRACE_SUBSCRIBER_METRICS = new Set([
  "lease_time_ns",
  "attributable_backpressure_ns",
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeWindowSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return TRACE_DEFAULT_WINDOW_SECONDS;
  }
  return clamp(value, TRACE_WINDOW_MIN_SECONDS, TRACE_WINDOW_MAX_SECONDS);
}

function defaultTraceWindowSecondsForRate(rateHz: number): number {
  if (!Number.isFinite(rateHz) || rateHz <= 0) {
    return TRACE_DEFAULT_WINDOW_SECONDS;
  }
  const targetSeconds = Math.max(TRACE_DEFAULT_WINDOW_SECONDS, Math.round(10 / rateHz));
  return normalizeWindowSeconds(targetSeconds);
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

function topicScopeForPublisher(
  topic: string,
  graphSnapshot: GraphSnapshotPayload | null
): Set<string> {
  const candidateTopics = new Set<string>([topic]);
  const routedTopics = graphSnapshot?.graph[topic];
  if (Array.isArray(routedTopics)) {
    for (const routedTopic of routedTopics) {
      if (typeof routedTopic === "string") {
        candidateTopics.add(routedTopic);
      }
    }
  }
  return candidateTopics;
}

function sampleTopicMatchesScope(sampleTopic: string, topicScope: Set<string>): boolean {
  if (topicScope.has(sampleTopic)) {
    return true;
  }
  for (const candidateTopic of topicScope) {
    if (sampleTopic.startsWith(`${candidateTopic}:`)) {
      return true;
    }
  }
  return false;
}

function contributorListForPublisher(
  topic: string,
  subscribers: SubscriberContributor[],
  graphSnapshot: GraphSnapshotPayload | null
): SubscriberContributor[] {
  const candidateTopics = topicScopeForPublisher(topic, graphSnapshot);

  return subscribers
    .filter((subscriber) => candidateTopics.has(subscriber.topic))
    .sort(
      (a, b) =>
        b.attributableBackpressureNsWindow - a.attributableBackpressureNsWindow
    );
}

function toPublisherRow(
  process: ProcessProfilingSnapshotPayload,
  publisher: PublisherProfilingSnapshot,
  allSubscribers: SubscriberContributor[],
  graphSnapshot: GraphSnapshotPayload | null
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
    contributors: contributorListForPublisher(
      publisher.topic,
      allSubscribers,
      graphSnapshot
    ),
  };
}

export function ProfilingPanel({
  graphSnapshot,
  profilingSnapshot,
  latestTraceEvent,
  setProfilingTraceControl,
}: ProfilingPanelProps) {
  const [searchText, setSearchText] = useState("");
  const [pressuredOnly, setPressuredOnly] = useState(false);
  const [hideZeroContributorRows, setHideZeroContributorRows] = useState(false);
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
  const [traceWindowSecondsByRowId, setTraceWindowSecondsByRowId] = useState<
    Record<string, number>
  >({});
  const [expandedContributorEndpointByRowId, setExpandedContributorEndpointByRowId] =
    useState<Record<string, string | null>>({});

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
        rows.push(toPublisherRow(process, publisher, allSubscribers, graphSnapshot));
      }
    }

    return rows.sort((a, b) => b.backpressureNsWindow - a.backpressureNsWindow);
  }, [graphSnapshot, processRows]);

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
    const activeRowsWithTopicScope = activeTraceRowIds
      .map((rowId) => rowById.get(rowId))
      .filter((row): row is PublisherRow => row !== undefined)
      .map((row) => ({
        row,
        topicScope: topicScopeForPublisher(row.topic, graphSnapshot),
      }));
    const topicScopeByRowId = new Map(
      activeRowsWithTopicScope.map((entry) => [entry.row.id, entry.topicScope])
    );
    setTraceSamplesByRowId((previous) => {
      let changed = false;
      const next: Record<string, PublisherTraceSample[]> = { ...previous };
      const pendingByRowId: Record<string, PublisherTraceSample[]> = {};
      for (const sample of extracted) {
        const matchedRowIds = new Set<string>();
        const publisherRow = rowById.get(sample.rowId);
        const publisherTopicScope = topicScopeByRowId.get(sample.rowId);
        if (
          publisherRow
          && activeIds.has(sample.rowId)
          && publisherTopicScope
          && sampleTopicMatchesScope(sample.topic, publisherTopicScope)
          && TRACE_PUBLISHER_METRICS.has(sample.metric)
        ) {
          matchedRowIds.add(sample.rowId);
        }
        if (TRACE_SUBSCRIBER_METRICS.has(sample.metric)) {
          for (const activeRow of activeRowsWithTopicScope) {
            if (sampleTopicMatchesScope(sample.topic, activeRow.topicScope)) {
              matchedRowIds.add(activeRow.row.id);
            }
          }
        }
        for (const rowId of matchedRowIds) {
          const pending = pendingByRowId[rowId];
          if (pending) {
            pending.push(sample);
          } else {
            pendingByRowId[rowId] = [sample];
          }
        }
      }
      for (const [rowId, pending] of Object.entries(pendingByRowId)) {
        if (pending.length === 0) {
          continue;
        }
        next[rowId] = pending;
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [activeTraceRowIds, graphSnapshot, latestTraceEvent, rowById]);

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
      setTraceWindowSecondsByRowId((previous) =>
        previous[row.id] !== undefined
          ? previous
          : {
              ...previous,
              [row.id]: defaultTraceWindowSecondsForRate(row.publishRateHzWindow),
            }
      );
      setActiveTraceRowIds([row.id]);
    } else {
      setActiveTraceRowIds((previous) =>
        previous.includes(row.id)
          ? previous.filter((existingId) => existingId !== row.id)
          : previous
      );
    }
    try {
      if (nextOpen) {
        const previousActiveId = activeTraceRowIds.find(
          (activeId) => activeId !== row.id
        );
        if (previousActiveId) {
          const previousRow = rowById.get(previousActiveId);
          if (previousRow) {
            await setProfilingTraceControl({
              process_id: previousRow.processId,
              enabled: false,
              publisher_endpoint_id: null,
              publisher_topic: null,
              subscriber_topic: null,
              metrics: null,
              sample_mod: 1,
              ttl_seconds: null,
              timeout: 2.0,
            });
          }
        }
      }
      await setProfilingTraceControl({
        process_id: row.processId,
        enabled: nextOpen,
        publisher_endpoint_id: nextOpen ? row.endpointId : null,
        publisher_topic: nextOpen ? row.topic : null,
        subscriber_topic: null,
        metrics: nextOpen
          ? [
              "publish_delta_ns",
              "lease_time_ns",
              "attributable_backpressure_ns",
            ]
          : null,
        sample_mod: 1,
        ttl_seconds: null,
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
    if (!nextExpanded) {
      setExpandedContributorEndpointByRowId((previous) => ({
        ...previous,
        [row.id]: null,
      }));
    }
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
            const traceWindowSeconds = normalizeWindowSeconds(
              traceWindowSecondsByRowId[row.id] ?? TRACE_DEFAULT_WINDOW_SECONDS
            );
            const traceTopicScope = Array.from(
              topicScopeForPublisher(row.topic, graphSnapshot)
            );
            const traceLeaseEndpointIds = traceSamples
              .filter((sample) => sample.metric === "lease_time_ns")
              .map((sample) => sample.endpointId);
            const leaseColorMap = buildLeaseColorMap([
              ...row.contributors.map((contributor) => contributor.endpointId),
              ...traceLeaseEndpointIds,
            ]);
            const visibleContributors = hideZeroContributorRows
              ? row.contributors.filter(
                  (contributor) => contributor.attributableBackpressureNsWindow > 0
                )
              : row.contributors;
            const expandedContributorEndpointId =
              expandedContributorEndpointByRowId[row.id] ?? null;
            const selectedContributorEndpointId = visibleContributors.some(
              (contributor) => contributor.endpointId === expandedContributorEndpointId
            )
              ? expandedContributorEndpointId
              : null;
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
                          <TraceTimingPanel
                            samples={traceSamples as TimingTraceSample[]}
                            publisherProcessId={row.processId}
                            publisherEndpointId={row.endpointId}
                            nominalPublishRateHz={row.publishRateHzWindow}
                            topic={row.topic}
                            topicScope={traceTopicScope}
                            leaseColorMap={leaseColorMap}
                            selectedLeaseEndpointId={selectedContributorEndpointId}
                            windowSeconds={traceWindowSeconds}
                            onWindowSecondsChange={(nextSeconds) =>
                              setTraceWindowSecondsByRowId((previous) => ({
                                ...previous,
                                [row.id]: normalizeWindowSeconds(nextSeconds),
                              }))
                            }
                          />
                        )}
                        {traceErrorMessage ? (
                          <p className="patch-status err">{traceErrorMessage}</p>
                        ) : null}
                      </div>
                    </details>

                    <div className="panel-section">
                      <div className="subscriber-section-header">
                        <h3>Subscribers</h3>
                        <button
                          type="button"
                          className={`subscriber-filter-btn ${
                            hideZeroContributorRows ? "is-active" : ""
                          }`}
                          onClick={() =>
                            setHideZeroContributorRows((previous) => !previous)
                          }
                        >
                          {hideZeroContributorRows ? "Hide Zero BP: On" : "Hide Zero BP: Off"}
                        </button>
                      </div>
                      {row.contributors.length === 0 ? (
                        <p className="muted">
                          No subscriber profiling data is available for this topic.
                        </p>
                      ) : visibleContributors.length === 0 ? (
                        <p className="muted">
                          No subscribers pass the current filter for this topic.
                        </p>
                      ) : (
                        <div className="subscriber-list">
                          {visibleContributors.map((contributor) => {
                            const attrBpAvgPerMessageNs =
                              contributor.messagesWindow > 0
                                ? contributor.attributableBackpressureNsWindow
                                  / contributor.messagesWindow
                                : 0;
                            const contributorExpanded =
                              selectedContributorEndpointId === contributor.endpointId;
                            return (
                              <article
                                className={`subscriber-item ${
                                  contributorExpanded ? "is-expanded" : ""
                                }`}
                                key={contributor.id}
                              >
                                <button
                                  type="button"
                                  className="subscriber-item__summary"
                                  onClick={() =>
                                    setExpandedContributorEndpointByRowId(
                                      (previous) => ({
                                        ...previous,
                                        [row.id]: contributorExpanded
                                          ? null
                                          : contributor.endpointId,
                                      })
                                    )
                                  }
                                >
                                  <div className="subscriber-item__identity">
                                    <p
                                      className="mono subscriber-topic-short"
                                      title={contributor.topic}
                                    >
                                      <span className="subscriber-topic-with-color">
                                        <i
                                          className="subscriber-trace-dot"
                                          style={{
                                            background: leaseColorForEndpoint(
                                              contributor.endpointId,
                                              leaseColorMap
                                            ),
                                          }}
                                        />
                                        {shortTopic(contributor.topic, 72)}
                                      </span>
                                    </p>
                                    <p
                                      className="muted mono subscriber-endpoint-token"
                                      title={contributor.endpointId}
                                    >
                                      endpoint {shortEndpointToken(contributor.endpointId)}
                                    </p>
                                  </div>
                                  <div className="subscriber-item__metrics">
                                    <span>
                                      <em>Backpressure Avg</em>
                                      <strong>
                                        {formatMs(attrBpAvgPerMessageNs)}
                                      </strong>
                                    </span>
                                    <span>
                                      <em>Events (total)</em>
                                      <strong>{contributor.attributableBackpressureEvents}</strong>
                                    </span>
                                    <span>
                                      <em>Msgs</em>
                                      <strong>{contributor.messagesWindow}</strong>
                                    </span>
                                  </div>
                                </button>
                                {contributorExpanded ? (
                                  <div className="subscriber-item__detail">
                                    <dl>
                                      <div className="subscriber-item__detail-row-full">
                                        <dt>Topic</dt>
                                        <dd className="mono">{contributor.topic}</dd>
                                      </div>
                                      <div className="subscriber-item__detail-row-full">
                                        <dt>Endpoint</dt>
                                        <dd className="mono">{contributor.endpointId}</dd>
                                      </div>
                                      <div>
                                        <dt>Process</dt>
                                        <dd className="mono">
                                          {contributor.processId.slice(0, 8)} (pid {contributor.pid})
                                        </dd>
                                      </div>
                                      <div>
                                        <dt>Host</dt>
                                        <dd>{contributor.host}</dd>
                                      </div>
                                      <div>
                                        <dt>User Span Avg</dt>
                                        <dd>{formatMs(contributor.userSpanNsAvgWindow)}</dd>
                                      </div>
                                      <div>
                                        <dt>Backpressure Sum (Window)</dt>
                                        <dd>{formatMs(contributor.attributableBackpressureNsWindow)}</dd>
                                      </div>
                                    </dl>
                                  </div>
                                ) : null}
                              </article>
                            );
                          })}
                        </div>
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
