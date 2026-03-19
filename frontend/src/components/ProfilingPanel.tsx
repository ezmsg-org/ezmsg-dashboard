import { useEffect, useMemo, useState } from "react";

import { Panel } from "./Panel";
import type {
  ProcessProfilingSnapshotPayload,
  ProfilingSnapshotPayload,
  PublisherProfilingSnapshot,
  SubscriberProfilingSnapshot,
} from "../types/api";
import type { ProfilingTraceEnvelope } from "../types/events";

type ProfilingPanelProps = {
  profilingSnapshot: ProfilingSnapshotPayload | null;
  latestTraceEvent: ProfilingTraceEnvelope | null;
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
  publishRateHzWindow: number;
  messagesPublishedWindow: number;
  publishDeltaNsAvgWindow: number;
  inflightCurrent: number;
  inflightPeakWindow: number;
  backpressureNsWindow: number;
  severity: Severity;
  contributors: SubscriberContributor[];
};

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
  const sameTopic = subscribers
    .filter((subscriber) => subscriber.topic === topic)
    .sort(
      (a, b) =>
        b.attributableBackpressureNsWindow - a.attributableBackpressureNsWindow
    );
  if (sameTopic.length === 0) {
    return [];
  }

  const pressured = sameTopic.filter(
    (subscriber) => subscriber.attributableBackpressureNsWindow > 0
  );
  return pressured.length > 0 ? pressured : sameTopic.slice(0, 6);
}

function toPublisherRow(
  process: ProcessProfilingSnapshotPayload,
  publisher: PublisherProfilingSnapshot,
  allSubscribers: SubscriberContributor[]
): PublisherRow {
  const backpressureNsWindow = toNumber(publisher.backpressure_wait_ns_window);
  const severity = backpressureSeverity(backpressureNsWindow);
  const rowId = `${process.process_id}:${publisher.endpoint_id}`;
  return {
    id: rowId,
    endpointId: publisher.endpoint_id,
    topic: publisher.topic,
    processId: process.process_id,
    pid: process.pid,
    host: process.host,
    publishRateHzWindow: toNumber(publisher.publish_rate_hz_window),
    messagesPublishedWindow: toNumber(publisher.messages_published_window),
    publishDeltaNsAvgWindow: toNumber(publisher.publish_delta_ns_avg_window),
    inflightCurrent: toNumber(publisher.inflight_messages_current),
    inflightPeakWindow: toNumber(publisher.inflight_messages_peak_window),
    backpressureNsWindow,
    severity,
    contributors: contributorListForPublisher(publisher.topic, allSubscribers),
  };
}

export function ProfilingPanel({
  profilingSnapshot,
  latestTraceEvent,
}: ProfilingPanelProps) {
  const [searchText, setSearchText] = useState("");
  const [pressuredOnly, setPressuredOnly] = useState(false);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);

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

  useEffect(() => {
    setExpandedIds((previous) => {
      const validIds = new Set(publisherRows.map((row) => row.id));
      const retained = previous.filter((id) => validIds.has(id));
      if (retained.length > 0) {
        return retained;
      }
      if (publisherRows.length === 0) {
        return [];
      }
      return [publisherRows[0].id];
    });
  }, [publisherRows]);

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

  const pressuredCount = useMemo(
    () => publisherRows.filter((row) => row.backpressureNsWindow > 0).length,
    [publisherRows]
  );

  const toggleExpanded = (id: string) => {
    setExpandedIds((previous) =>
      previous.includes(id)
        ? previous.filter((existingId) => existingId !== id)
        : [...previous, id]
    );
  };

  return (
    <Panel
      title="Profiling"
      subtitle="Publisher-first backpressure diagnostics"
    >
      <div className="stats-grid">
        <article className="stat-card">
          <span>Publishers</span>
          <strong>{publisherRows.length}</strong>
        </article>
        <article className="stat-card">
          <span>Pressured Publishers</span>
          <strong>{pressuredCount}</strong>
        </article>
        <article className="stat-card">
          <span>Trace Batches</span>
          <strong>
            {latestTraceEvent ? Object.keys(latestTraceEvent.data.batches).length : 0}
          </strong>
        </article>
      </div>

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
            return (
              <article
                key={row.id}
                className={`publisher-row severity-${row.severity}`}
              >
                <div className="publisher-row__summary">
                  <div className="publisher-row__identity">
                    <span className={`severity-dot severity-${row.severity}`} />
                    <div>
                      <p className="mono">{row.topic}</p>
                      <p className="muted mono">
                        {row.endpointId} · {row.processId.slice(0, 8)} · pid {row.pid}
                      </p>
                    </div>
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
                        {row.inflightCurrent} / {row.inflightPeakWindow}
                      </strong>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="publisher-expand-btn"
                    onClick={() => toggleExpanded(row.id)}
                  >
                    {expanded ? "Hide" : "Details"}
                  </button>
                </div>

                {expanded ? (
                  <div className="publisher-row__details">
                    <div className="publisher-kpis">
                      <article className="mini-kpi">
                        <span>Messages (window)</span>
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

                    <div className="panel-section">
                      <h3>Likely Subscriber Contributors</h3>
                      {row.contributors.length === 0 ? (
                        <p className="muted">
                          No subscriber profiling data is available for this topic.
                        </p>
                      ) : (
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Subscriber Endpoint</th>
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
                                <td className="mono">{contributor.endpointId}</td>
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
