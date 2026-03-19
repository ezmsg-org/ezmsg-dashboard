import { useMemo } from "react";

import { ProfilingPanel } from "./components/ProfilingPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { TopologyPanel } from "./components/TopologyPanel";

export function App() {
  const now = useMemo(() => new Date().toLocaleString(), []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>ezmsg Dashboard</h1>
        <p>React-first operations UI scaffold</p>
        <span className="timestamp">Loaded {now}</span>
      </header>

      <main className="panel-grid">
        <TopologyPanel />
        <ProfilingPanel />
        <SettingsPanel />
      </main>
    </div>
  );
}
