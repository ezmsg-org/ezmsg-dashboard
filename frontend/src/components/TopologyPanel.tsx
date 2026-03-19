import { Panel } from "./Panel";
import type { GraphSnapshotPayload } from "../types/api";
import type { TopologyChangedEnvelope } from "../types/events";

type TopologyPanelProps = {
  graphSnapshot: GraphSnapshotPayload | null;
  recentEvents: TopologyChangedEnvelope[];
};

function graphEdgeCount(graph: Record<string, string[]>): number {
  return Object.values(graph).reduce((total, targets) => total + targets.length, 0);
}

export function TopologyPanel({ graphSnapshot, recentEvents }: TopologyPanelProps) {
  if (!graphSnapshot) {
    return (
      <Panel
        title="Topology"
        subtitle="Live graph, process ownership, and edge changes"
      >
        <div className="placeholder">
          <p>Waiting for initial snapshot...</p>
        </div>
      </Panel>
    );
  }

  const topicCount = Object.keys(graphSnapshot.graph).length;
  const edgeCount = graphEdgeCount(graphSnapshot.graph);
  const sessionCount = Object.keys(graphSnapshot.sessions).length;
  const processRows = Object.values(graphSnapshot.processes);

  return (
    <Panel
      title="Topology"
      subtitle="Live graph, process ownership, and edge changes"
    >
      <div className="stats-grid">
        <article className="stat-card">
          <span>Topics</span>
          <strong>{topicCount}</strong>
        </article>
        <article className="stat-card">
          <span>Edges</span>
          <strong>{edgeCount}</strong>
        </article>
        <article className="stat-card">
          <span>Sessions</span>
          <strong>{sessionCount}</strong>
        </article>
        <article className="stat-card">
          <span>Processes</span>
          <strong>{processRows.length}</strong>
        </article>
      </div>

      <div className="panel-section">
        <h3>Process Ownership</h3>
        {processRows.length === 0 ? (
          <p className="muted">No process ownership in current snapshot.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Process ID</th>
                <th>PID</th>
                <th>Host</th>
                <th>Units</th>
              </tr>
            </thead>
            <tbody>
              {processRows.map((process) => (
                <tr key={process.process_id}>
                  <td className="mono">{process.process_id.slice(0, 8)}</td>
                  <td>{process.pid ?? "-"}</td>
                  <td>{process.host ?? "-"}</td>
                  <td>{process.units.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel-section">
        <h3>Recent Topology Changes</h3>
        {recentEvents.length === 0 ? (
          <p className="muted">No topology events received yet.</p>
        ) : (
          <ul className="event-list">
            {recentEvents.slice(0, 8).map((event) => (
              <li key={`topo-${event.data.seq}`} className="event-item">
                <span className="event-pill">{event.data.event_type}</span>
                <span className="mono">seq {event.data.seq}</span>
                <span>
                  {event.data.changed_topics.length > 0
                    ? event.data.changed_topics.join(", ")
                    : "No topic list"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
