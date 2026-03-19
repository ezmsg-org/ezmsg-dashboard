import { useEffect, useMemo, useState } from "react";

import { Panel } from "./Panel";
import type { SettingsSnapshotPayload } from "../types/api";

type SettingsPanelProps = {
  settings: SettingsSnapshotPayload | null;
};

export function SettingsPanel({ settings }: SettingsPanelProps) {
  const componentAddresses = useMemo(
    () => (settings ? Object.keys(settings).sort() : []),
    [settings]
  );
  const [selectedComponent, setSelectedComponent] = useState<string | null>(null);

  useEffect(() => {
    if (selectedComponent && componentAddresses.includes(selectedComponent)) {
      return;
    }
    setSelectedComponent(componentAddresses[0] ?? null);
  }, [componentAddresses, selectedComponent]);

  const selectedValue = selectedComponent ? settings?.[selectedComponent] : null;

  return (
    <Panel
      title="Settings"
      subtitle="Inspect structured settings and apply field-level updates"
    >
      <div className="stats-grid">
        <article className="stat-card">
          <span>Components</span>
          <strong>{componentAddresses.length}</strong>
        </article>
        <article className="stat-card">
          <span>Selected</span>
          <strong>
            {selectedComponent
              ? selectedComponent.split(".").slice(-1)[0]
              : "-"}
          </strong>
        </article>
      </div>

      {componentAddresses.length === 0 ? (
        <div className="panel-section">
          <p className="muted">No settings snapshot entries available.</p>
        </div>
      ) : (
        <div className="settings-layout">
          <aside className="settings-list">
            {componentAddresses.map((address) => (
              <button
                key={address}
                type="button"
                className={`settings-item ${
                  selectedComponent === address ? "is-active" : ""
                }`}
                onClick={() => setSelectedComponent(address)}
              >
                <span className="mono">{address}</span>
              </button>
            ))}
          </aside>
          <section className="settings-detail">
            <h3 className="mono">{selectedComponent}</h3>
            <pre className="json-block">
              {selectedValue
                ? JSON.stringify(selectedValue.structured_value ?? selectedValue.repr_value, null, 2)
                : "{}"}
            </pre>
          </section>
        </div>
      )}
    </Panel>
  );
}
