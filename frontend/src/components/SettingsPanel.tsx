import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Panel } from "./Panel";
import type {
  SettingsSchemaField,
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
  type EditorMode = "boolean" | "number" | "choice" | "text" | "json";

  const inferEditorMode = (field: SettingsSchemaField): EditorMode => {
    const fieldType = field.field_type.toLowerCase();
    if (Array.isArray(field.choices) && field.choices.length > 0) {
      return "choice";
    }
    if (fieldType.includes("bool")) {
      return "boolean";
    }
    if (
      fieldType.includes("int")
      || fieldType.includes("float")
      || fieldType.includes("double")
      || fieldType.includes("number")
    ) {
      return "number";
    }
    if (fieldType.includes("str") || fieldType.includes("string")) {
      return "text";
    }
    return "json";
  };

  const readPathValue = (value: unknown, path: string): unknown => {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const keys = path.split(".").filter((part) => part.length > 0);
    let current: unknown = value;
    for (const key of keys) {
      if (!current || typeof current !== "object" || !(key in current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  };

  const toDisplayJson = (value: unknown): string => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };

  const componentAddresses = useMemo(
    () => (settings ? Object.keys(settings).sort() : []),
    [settings]
  );
  const [selectedComponent, setSelectedComponent] = useState<string | null>(null);
  const [selectedFieldPath, setSelectedFieldPath] = useState("");
  const [editorMode, setEditorMode] = useState<EditorMode>("json");
  const [patchTextValue, setPatchTextValue] = useState("{}");
  const [patchBoolValue, setPatchBoolValue] = useState(false);
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
  const schemaFields = selectedValue?.settings_schema?.fields ?? [];
  const selectedField =
    schemaFields.find((field) => field.name === selectedFieldPath) ?? null;
  const patchable = Boolean(selectedValue?.patchable);

  useEffect(() => {
    if (schemaFields.length === 0) {
      setSelectedFieldPath("");
      return;
    }
    const exists = schemaFields.some((field) => field.name === selectedFieldPath);
    if (!exists) {
      setSelectedFieldPath(schemaFields[0].name);
    }
  }, [schemaFields, selectedFieldPath]);

  useEffect(() => {
    if (!previewValue) {
      setPatchTextValue("{}");
    } else {
      setPatchTextValue(JSON.stringify(previewValue, null, 2));
    }
  }, [selectedComponent, previewValue]);

  useEffect(() => {
    if (!selectedField) {
      return;
    }

    const mode = inferEditorMode(selectedField);
    setEditorMode(mode);
    const sourceValue = previewValue ?? {};
    const currentValue = readPathValue(sourceValue, selectedField.name);
    const initialValue = currentValue ?? selectedField.default ?? null;

    if (mode === "boolean") {
      setPatchBoolValue(Boolean(initialValue));
      return;
    }

    if (mode === "choice") {
      const choices = selectedField.choices ?? [];
      const index = Math.max(
        0,
        choices.findIndex((choice) => JSON.stringify(choice) === JSON.stringify(initialValue))
      );
      setPatchTextValue(String(index));
      return;
    }

    if (mode === "number") {
      setPatchTextValue(
        typeof initialValue === "number" ? String(initialValue) : ""
      );
      return;
    }

    if (mode === "text") {
      setPatchTextValue(typeof initialValue === "string" ? initialValue : "");
      return;
    }

    setPatchTextValue(toDisplayJson(initialValue));
  }, [selectedComponent, selectedFieldPath, selectedField, previewValue]);

  const onSubmitPatch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedComponent) {
      return;
    }
    if (!patchable) {
      setPatchError("This component is read-only.");
      setPatchSuccess(null);
      return;
    }
    if (!selectedField) {
      setPatchError("No schema field is selected.");
      setPatchSuccess(null);
      return;
    }

    let parsedValue: unknown = null;
    if (editorMode === "boolean") {
      parsedValue = patchBoolValue;
    } else if (editorMode === "choice") {
      const index = Number.parseInt(patchTextValue, 10);
      const choices = selectedField.choices ?? [];
      if (!Number.isInteger(index) || index < 0 || index >= choices.length) {
        setPatchError("A valid choice must be selected.");
        setPatchSuccess(null);
        return;
      }
      parsedValue = choices[index];
    } else if (editorMode === "number") {
      const numeric = Number.parseFloat(patchTextValue);
      if (!Number.isFinite(numeric)) {
        setPatchError("Value must be a valid number.");
        setPatchSuccess(null);
        return;
      }
      const isIntType = selectedField.field_type.toLowerCase().includes("int");
      parsedValue = isIntType ? Math.trunc(numeric) : numeric;
    } else if (editorMode === "text") {
      parsedValue = patchTextValue;
    } else {
      try {
        parsedValue = JSON.parse(patchTextValue);
      } catch {
        setPatchError("Value must be valid JSON.");
        setPatchSuccess(null);
        return;
      }
    }

    setPatchPending(true);
    setPatchError(null);
    setPatchSuccess(null);
    try {
      const response = await patchSettingField(
        selectedComponent,
        selectedField.name,
        parsedValue
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
          <span>Selected Component</span>
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
                } ${
                  settings?.[address]?.patchable ? "is-patchable" : "is-readonly"
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

      {patchable ? (
        <div className="panel-section">
          <h3>Patch Field</h3>
          {schemaFields.length === 0 ? (
            <p className="muted">
              Settings schema metadata is unavailable; field-level patch widgets cannot be generated.
            </p>
          ) : (
            <form className="patch-form" onSubmit={onSubmitPatch}>
              <label>
                <span>Field</span>
                <select
                  value={selectedFieldPath}
                  onChange={(event) => setSelectedFieldPath(event.target.value)}
                  disabled={!selectedComponent || schemaFields.length === 0 || patchPending}
                >
                  {schemaFields.map((field) => (
                    <option key={field.name} value={field.name}>
                      {field.name}
                    </option>
                  ))}
                </select>
              </label>

              {selectedField ? (
                <p className="muted">
                  {selectedField.description ?? "No field description available."}
                  {selectedField.bounds
                    ? ` Bounds: [${selectedField.bounds[0] ?? "-inf"}, ${selectedField.bounds[1] ?? "+inf"}]`
                    : ""}
                </p>
              ) : null}

              {editorMode === "boolean" ? (
                <label className="patch-checkbox">
                  <input
                    type="checkbox"
                    checked={patchBoolValue}
                    onChange={(event) => setPatchBoolValue(event.target.checked)}
                    disabled={!selectedComponent || patchPending}
                  />
                  <span>Enabled</span>
                </label>
              ) : null}

              {editorMode === "choice" ? (
                <label>
                  <span>Value</span>
                  <select
                    value={patchTextValue}
                    onChange={(event) => setPatchTextValue(event.target.value)}
                    disabled={!selectedComponent || patchPending}
                  >
                    {(selectedField?.choices ?? []).map((choice, index) => (
                      <option key={`${selectedField?.name}-${index}`} value={String(index)}>
                        {toDisplayJson(choice)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {editorMode === "number" ? (
                <label>
                  <span>Value</span>
                  <input
                    type="number"
                    value={patchTextValue}
                    min={selectedField?.bounds?.[0] ?? undefined}
                    max={selectedField?.bounds?.[1] ?? undefined}
                    step="any"
                    onChange={(event) => setPatchTextValue(event.target.value)}
                    disabled={!selectedComponent || patchPending}
                  />
                </label>
              ) : null}

              {editorMode === "text" ? (
                <label>
                  <span>Value</span>
                  <input
                    type="text"
                    value={patchTextValue}
                    onChange={(event) => setPatchTextValue(event.target.value)}
                    disabled={!selectedComponent || patchPending}
                  />
                </label>
              ) : null}

              {editorMode === "json" ? (
                <label>
                  <span>Value (JSON)</span>
                  <textarea
                    value={patchTextValue}
                    onChange={(event) => setPatchTextValue(event.target.value)}
                    rows={7}
                    spellCheck={false}
                    className="mono"
                    disabled={!selectedComponent || patchPending}
                  />
                </label>
              ) : null}

              <div className="patch-form__actions">
                <button
                  type="submit"
                  disabled={
                    !selectedComponent
                    || !selectedField
                    || schemaFields.length === 0
                    || patchPending
                  }
                >
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
          )}
        </div>
      ) : null}
    </Panel>
  );
}
