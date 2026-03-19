import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Panel } from "./Panel";
import type {
  SettingsFieldPatchResponse,
  SettingsSnapshotPayload,
} from "../types/api";

type SettingsPanelProps = {
  settings: SettingsSnapshotPayload | null;
  patchSettingField: (
    componentAddress: string,
    fieldPath: string,
    value: unknown,
    timeout?: number
  ) => Promise<SettingsFieldPatchResponse>;
};

export function SettingsPanel({
  settings,
  patchSettingField,
}: SettingsPanelProps) {
  const componentAddresses = useMemo(
    () => (settings ? Object.keys(settings).sort() : []),
    [settings]
  );
  const [selectedComponent, setSelectedComponent] = useState<string | null>(null);
  const [patchFieldPath, setPatchFieldPath] = useState("");
  const [patchValueText, setPatchValueText] = useState("{}");
  const [patchTimeout, setPatchTimeout] = useState("2.0");
  const [patchPending, setPatchPending] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [patchSuccess, setPatchSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (selectedComponent && componentAddresses.includes(selectedComponent)) {
      return;
    }
    setSelectedComponent(componentAddresses[0] ?? null);
  }, [componentAddresses, selectedComponent]);

  const selectedValue = selectedComponent ? settings?.[selectedComponent] : null;
  const previewValue = selectedValue?.structured_value ?? selectedValue?.repr_value;

  useEffect(() => {
    if (!previewValue) {
      setPatchValueText("{}");
      return;
    }
    setPatchValueText(JSON.stringify(previewValue, null, 2));
  }, [selectedComponent, previewValue]);

  const onSubmitPatch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedComponent) {
      return;
    }

    const normalizedPath = patchFieldPath.trim();
    if (normalizedPath.length === 0) {
      setPatchError("Field path is required.");
      setPatchSuccess(null);
      return;
    }

    const timeout = Number.parseFloat(patchTimeout);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      setPatchError("Timeout must be a positive number.");
      setPatchSuccess(null);
      return;
    }

    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(patchValueText);
    } catch {
      setPatchError("Value must be valid JSON.");
      setPatchSuccess(null);
      return;
    }

    setPatchPending(true);
    setPatchError(null);
    setPatchSuccess(null);
    try {
      const response = await patchSettingField(
        selectedComponent,
        normalizedPath,
        parsedValue,
        timeout
      );
      setPatchSuccess(
        `Patched ${response.component_address}.${response.field_path}`
      );
    } catch (patchErr: unknown) {
      setPatchError(
        patchErr instanceof Error ? patchErr.message : "Patch request failed."
      );
    } finally {
      setPatchPending(false);
    }
  };

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
              {selectedValue ? JSON.stringify(previewValue, null, 2) : "{}"}
            </pre>
          </section>
        </div>
      )}

      <div className="panel-section">
        <h3>Patch Field</h3>
        <form className="patch-form" onSubmit={onSubmitPatch}>
          <label>
            <span>Field path</span>
            <input
              type="text"
              value={patchFieldPath}
              onChange={(event) => setPatchFieldPath(event.target.value)}
              placeholder="enabled or nested.path.value"
              disabled={!selectedComponent || patchPending}
            />
          </label>

          <label>
            <span>Value (JSON)</span>
            <textarea
              value={patchValueText}
              onChange={(event) => setPatchValueText(event.target.value)}
              rows={7}
              spellCheck={false}
              className="mono"
              disabled={!selectedComponent || patchPending}
            />
          </label>

          <label>
            <span>Timeout seconds</span>
            <input
              type="text"
              value={patchTimeout}
              onChange={(event) => setPatchTimeout(event.target.value)}
              disabled={!selectedComponent || patchPending}
            />
          </label>

          <div className="patch-form__actions">
            <button type="submit" disabled={!selectedComponent || patchPending}>
              {patchPending ? "Applying..." : "Apply Patch"}
            </button>
            {patchSuccess ? (
              <span className="patch-status ok">{patchSuccess}</span>
            ) : null}
            {patchError ? (
              <span className="patch-status err">{patchError}</span>
            ) : null}
          </div>
        </form>
      </div>
    </Panel>
  );
}
