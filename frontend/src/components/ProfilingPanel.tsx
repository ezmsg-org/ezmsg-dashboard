import { Panel } from "./Panel";
import type { ProfilingSnapshotPayload } from "../types/api";
import type { ProfilingTraceEnvelope } from "../types/events";

type ProfilingPanelProps = {
  profilingSnapshot: ProfilingSnapshotPayload | null;
  latestTraceEvent: ProfilingTraceEnvelope | null;
};

function summarizePublisherWindow(
  publishers: Record<string, { messages_published_window: number }>
): number {
  return Object.values(publishers).reduce(
    (sum, publisher) => sum + publisher.messages_published_window,
    0
  );
}

function summarizeSubscriberWindow(
  subscribers: Record<string, { messages_received_window: number }>
): number {
  return Object.values(subscribers).reduce(
    (sum, subscriber) => sum + subscriber.messages_received_window,
    0
  );
}

export function ProfilingPanel({
  profilingSnapshot,
  latestTraceEvent,
}: ProfilingPanelProps) {
  const profilingRows = profilingSnapshot
    ? Object.values(profilingSnapshot)
    : [];

  return (
    <Panel
      title="Profiling"
      subtitle="Snapshot and trace streams for throughput and latency"
    >
      <div className="stats-grid">
        <article className="stat-card">
          <span>Profiled Processes</span>
          <strong>{profilingRows.length}</strong>
        </article>
        <article className="stat-card">
          <span>Trace Batches</span>
          <strong>
            {latestTraceEvent ? Object.keys(latestTraceEvent.data.batches).length : 0}
          </strong>
        </article>
      </div>

      <div className="panel-section">
        <h3>Per-Process Snapshot</h3>
        {profilingRows.length === 0 ? (
          <p className="muted">No profiling snapshots available.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Process</th>
                <th>PID</th>
                <th>Publishers</th>
                <th>Subscribers</th>
                <th>Msgs Out (window)</th>
                <th>Msgs In (window)</th>
              </tr>
            </thead>
            <tbody>
              {profilingRows.map((process) => (
                <tr key={process.process_id}>
                  <td className="mono">{process.process_id.slice(0, 8)}</td>
                  <td>{process.pid}</td>
                  <td>{Object.keys(process.publishers).length}</td>
                  <td>{Object.keys(process.subscribers).length}</td>
                  <td>{summarizePublisherWindow(process.publishers)}</td>
                  <td>{summarizeSubscriberWindow(process.subscribers)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel-section">
        <h3>Trace Stream</h3>
        {latestTraceEvent ? (
          <p className="muted">
            Latest batch timestamp:{" "}
            <span className="mono">
              {latestTraceEvent.data.timestamp.toFixed(3)}
            </span>
          </p>
        ) : (
          <p className="muted">No trace batches received yet.</p>
        )}
      </div>
    </Panel>
  );
}
