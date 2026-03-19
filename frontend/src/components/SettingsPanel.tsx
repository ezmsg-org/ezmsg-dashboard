import { Panel } from "./Panel";

export function SettingsPanel() {
  return (
    <Panel
      title="Settings"
      subtitle="Inspect structured settings and apply field-level updates"
    >
      <div className="placeholder">
        <p>Schema-driven settings scaffold</p>
        <ul>
          <li>Component selector</li>
          <li>Current settings JSON viewer</li>
          <li>Field patch action panel</li>
        </ul>
      </div>
    </Panel>
  );
}
