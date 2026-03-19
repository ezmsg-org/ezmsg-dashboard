import { useMemo } from "react";

import { ProfilingPanel } from "./components/ProfilingPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { TopologyPanel } from "./components/TopologyPanel";
import { useDashboardData } from "./hooks/useDashboardData";

export function App() {
  const now = useMemo(() => new Date().toLocaleString(), []);
  const {
    health,
    snapshot,
    latestTraceEvent,
    connectionState,
    error,
    lastSnapshotUpdateMs,
    topologyEvents,
    refreshSnapshot,
    patchSettingField,
  } = useDashboardData();
  const snapshotUpdatedAt = lastSnapshotUpdateMs
    ? new Date(lastSnapshotUpdateMs).toLocaleTimeString()
    : "n/a";

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>ezmsg Dashboard</h1>
        <p>Topology, profiling, and settings from live GraphContext bridge</p>
        <span className="timestamp">Loaded {now}</span>
        <div className="status-row">
          <span className={`status-pill is-${connectionState}`}>
            WS {connectionState}
          </span>
          <span
            className={`status-pill ${
              health?.graph_session_active ? "is-open" : "is-closed"
            }`}
          >
            Graph session {health?.graph_session_active ? "active" : "inactive"}
          </span>
          <button type="button" className="refresh-btn" onClick={() => refreshSnapshot()}>
            Refresh Snapshot
          </button>
          <span className="snapshot-time">Snapshot updated {snapshotUpdatedAt}</span>
        </div>
        {error ? <p className="error-text">{error}</p> : null}
      </header>

      <main className="panel-grid">
        <TopologyPanel
          graphSnapshot={snapshot?.snapshot ?? null}
          recentEvents={topologyEvents}
        />
        <ProfilingPanel
          profilingSnapshot={snapshot?.profiling ?? null}
          latestTraceEvent={latestTraceEvent}
        />
        <SettingsPanel
          settings={snapshot?.settings ?? null}
          patchSettingField={patchSettingField}
        />
      </main>
    </div>
  );
}
