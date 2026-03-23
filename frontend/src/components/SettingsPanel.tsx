import { useEffect, useMemo, useState } from "react";

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
  focusComponentAddress?: string | null;
};

type EditorMode = "boolean" | "number" | "choice" | "text" | "json";

type FieldRow = {
  path: string;
  mode: EditorMode;
  currentValue: unknown;
  description: string | null;
  bounds: [number | null, number | null] | null;
  choices: unknown[] | null;
  isInteger: boolean;
};

function inferSchemaEditorMode(field: SettingsSchemaField): EditorMode {
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
}

function inferValueEditorMode(value: unknown): EditorMode {
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "string") {
    return "text";
  }
  return "json";
}

function readPathValue(value: unknown, path: string): unknown {
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
}

function toDisplayJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function flattenLeafPaths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix.length > 0 ? [prefix] : [];
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return prefix.length > 0 ? [prefix] : [];
  }
  const paths: string[] = [];
  for (const [key, nested] of entries) {
    const nextPrefix = prefix.length > 0 ? `${prefix}.${key}` : key;
    const nestedPaths = flattenLeafPaths(nested, nextPrefix);
    if (nestedPaths.length === 0) {
      paths.push(nextPrefix);
    } else {
      paths.push(...nestedPaths);
    }
  }
  return paths;
}

function initialDraftValueForRow(row: FieldRow): unknown {
  if (row.mode === "boolean") {
    return Boolean(row.currentValue);
  }
  if (row.mode === "choice") {
    const choices = row.choices ?? [];
    const index = Math.max(
      0,
      choices.findIndex(
        (choice) => JSON.stringify(choice) === JSON.stringify(row.currentValue)
      )
    );
    return String(index);
  }
  if (row.mode === "number") {
    return typeof row.currentValue === "number" ? String(row.currentValue) : "";
  }
  if (row.mode === "text") {
    return typeof row.currentValue === "string" ? row.currentValue : "";
  }
  return toDisplayJson(row.currentValue);
}

export function SettingsPanel({
  settings,
  patchSettingField,
  focusComponentAddress = null,
}: SettingsPanelProps) {
  const allComponentAddresses = useMemo(
    () => (settings ? Object.keys(settings).sort() : []),
    [settings]
  );
  const focusedAddress = useMemo(() => {
    if (!focusComponentAddress || !settings?.[focusComponentAddress]) {
      return null;
    }
    return focusComponentAddress;
  }, [focusComponentAddress, settings]);
  const componentAddresses = focusedAddress
    ? [focusedAddress]
    : allComponentAddresses;
  const [selectedComponent, setSelectedComponent] = useState<string | null>(null);
  const [fieldDrafts, setFieldDrafts] = useState<Record<string, unknown>>({});
  const [pendingByField, setPendingByField] = useState<Record<string, boolean>>({});
  const [errorByField, setErrorByField] = useState<Record<string, string | null>>({});
  const [successByField, setSuccessByField] = useState<Record<string, string | null>>({});

  useEffect(() => {
    if (focusedAddress) {
      if (selectedComponent !== focusedAddress) {
        setSelectedComponent(focusedAddress);
      }
      return;
    }
    if (selectedComponent && componentAddresses.includes(selectedComponent)) {
      return;
    }
    setSelectedComponent(componentAddresses[0] ?? null);
  }, [componentAddresses, focusedAddress, selectedComponent]);

  const selectedValue = selectedComponent ? settings?.[selectedComponent] : null;
  const previewValue = useMemo(
    () => selectedValue?.structured_value ?? selectedValue?.repr_value,
    [selectedValue]
  );
  const fieldRows = useMemo<FieldRow[]>(() => {
    if (!selectedValue) {
      return [];
    }

    const schemaFields = selectedValue.settings_schema?.fields ?? [];
    if (schemaFields.length > 0) {
      return schemaFields.map((field) => {
        const currentValue = readPathValue(previewValue, field.name);
        return {
          path: field.name,
          mode: inferSchemaEditorMode(field),
          currentValue: currentValue ?? field.default ?? null,
          description: field.description,
          bounds: field.bounds,
          choices: field.choices,
          isInteger: field.field_type.toLowerCase().includes("int"),
        };
      });
    }

    const flattenedPaths = flattenLeafPaths(previewValue);
    const fallbackPaths = flattenedPaths.length > 0 ? flattenedPaths : ["value"];
    return fallbackPaths.map((path) => {
      const currentValue =
        path === "value" ? previewValue : readPathValue(previewValue, path);
      return {
        path,
        mode: inferValueEditorMode(currentValue),
        currentValue,
        description: null,
        bounds: null,
        choices: null,
        isInteger: Number.isInteger(currentValue),
      };
    });
  }, [selectedValue, previewValue]);

  const patchable = Boolean(selectedValue?.patchable);

  useEffect(() => {
    const drafts: Record<string, unknown> = {};
    for (const row of fieldRows) {
      drafts[row.path] = initialDraftValueForRow(row);
    }
    setFieldDrafts(drafts);
    setPendingByField({});
    setErrorByField({});
    setSuccessByField({});
  }, [selectedComponent, fieldRows]);

  const parseRowDraft = (row: FieldRow): unknown => {
    const draftValue = fieldDrafts[row.path];
    if (row.mode === "boolean") {
      return Boolean(draftValue);
    }
    if (row.mode === "choice") {
      const index = Number.parseInt(String(draftValue), 10);
      const choices = row.choices ?? [];
      if (!Number.isInteger(index) || index < 0 || index >= choices.length) {
        throw new Error("A valid choice must be selected.");
      }
      return choices[index];
    }
    if (row.mode === "number") {
      const numeric = Number.parseFloat(String(draftValue));
      if (!Number.isFinite(numeric)) {
        throw new Error("Value must be a valid number.");
      }
      return row.isInteger ? Math.trunc(numeric) : numeric;
    }
    if (row.mode === "text") {
      return String(draftValue ?? "");
    }
    try {
      return JSON.parse(String(draftValue ?? ""));
    } catch {
      throw new Error("Value must be valid JSON.");
    }
  };

  const applyFieldPatch = async (row: FieldRow): Promise<void> => {
    if (!selectedComponent || !patchable) {
      return;
    }

    let parsedValue: unknown;
    try {
      parsedValue = parseRowDraft(row);
    } catch (parseError: unknown) {
      setErrorByField((previous) => ({
        ...previous,
        [row.path]:
          parseError instanceof Error ? parseError.message : "Invalid field value.",
      }));
      setSuccessByField((previous) => ({ ...previous, [row.path]: null }));
      return;
    }

    setPendingByField((previous) => ({ ...previous, [row.path]: true }));
    setErrorByField((previous) => ({ ...previous, [row.path]: null }));
    setSuccessByField((previous) => ({ ...previous, [row.path]: null }));
    try {
      const response = await patchSettingField(
        selectedComponent,
        row.path,
        parsedValue
      );
      setSuccessByField((previous) => ({
        ...previous,
        [row.path]: `Applied ${response.field_path}`,
      }));
    } catch (patchErr: unknown) {
      setErrorByField((previous) => ({
        ...previous,
        [row.path]: patchErr instanceof Error ? patchErr.message : "Patch request failed.",
      }));
    } finally {
      setPendingByField((previous) => ({ ...previous, [row.path]: false }));
    }
  };

  return (
    <Panel
      title="Settings"
      subtitle="Inspect structured settings and apply field-level updates"
    >
      {componentAddresses.length === 0 ? (
        <div className="panel-section">
          <p className="muted">No settings snapshot entries available.</p>
        </div>
      ) : (
        <div className={`settings-layout ${focusedAddress ? "is-focused" : ""}`}>
          {focusedAddress ? null : (
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
          )}
          <section className="settings-detail">
            <div className="settings-detail__heading">
              <h3 className="mono">{selectedComponent}</h3>
              {selectedValue?.component_type ? (
                <span className="settings-type">
                  {selectedValue.component_type}
                </span>
              ) : null}
            </div>
            {selectedValue?.component_name ? (
              <p className="muted">{selectedValue.component_name}</p>
            ) : null}
            {fieldRows.length === 0 ? (
              <p className="muted">No fields available for this component.</p>
            ) : (
              <div className="settings-fields">
                {fieldRows.map((row) => {
                  const pending = pendingByField[row.path] === true;
                  const rowDisabled = !patchable;
                  const draft = fieldDrafts[row.path];
                  return (
                    <div
                      key={row.path}
                      className={`settings-field-row ${rowDisabled ? "is-disabled" : ""}`}
                    >
                      <div className="settings-field-row__meta">
                        <label className="mono">{row.path}</label>
                        {row.description ? <p className="muted">{row.description}</p> : null}
                        {row.bounds ? (
                          <p className="muted">
                            Bounds: [{row.bounds[0] ?? "-inf"}, {row.bounds[1] ?? "+inf"}]
                          </p>
                        ) : null}
                      </div>
                      <div className="settings-field-row__control">
                        {row.mode === "boolean" ? (
                          <label className="patch-checkbox">
                            <input
                              type="checkbox"
                              checked={Boolean(draft)}
                              onChange={(event) =>
                                setFieldDrafts((previous) => ({
                                  ...previous,
                                  [row.path]: event.target.checked,
                                }))
                              }
                              disabled={rowDisabled || pending}
                            />
                            <span>Enabled</span>
                          </label>
                        ) : null}

                        {row.mode === "choice" ? (
                          <select
                            value={String(draft ?? "0")}
                            onChange={(event) =>
                              setFieldDrafts((previous) => ({
                                ...previous,
                                [row.path]: event.target.value,
                              }))
                            }
                            disabled={rowDisabled || pending}
                          >
                            {(row.choices ?? []).map((choice, index) => (
                              <option key={`${row.path}-${index}`} value={String(index)}>
                                {toDisplayJson(choice)}
                              </option>
                            ))}
                          </select>
                        ) : null}

                        {row.mode === "number" ? (
                          <input
                            type="number"
                            value={String(draft ?? "")}
                            min={row.bounds?.[0] ?? undefined}
                            max={row.bounds?.[1] ?? undefined}
                            step="any"
                            onChange={(event) =>
                              setFieldDrafts((previous) => ({
                                ...previous,
                                [row.path]: event.target.value,
                              }))
                            }
                            disabled={rowDisabled || pending}
                          />
                        ) : null}

                        {row.mode === "text" ? (
                          <input
                            type="text"
                            value={String(draft ?? "")}
                            onChange={(event) =>
                              setFieldDrafts((previous) => ({
                                ...previous,
                                [row.path]: event.target.value,
                              }))
                            }
                            disabled={rowDisabled || pending}
                          />
                        ) : null}

                        {row.mode === "json" ? (
                          <textarea
                            value={String(draft ?? "")}
                            rows={4}
                            spellCheck={false}
                            className="mono"
                            onChange={(event) =>
                              setFieldDrafts((previous) => ({
                                ...previous,
                                [row.path]: event.target.value,
                              }))
                            }
                            disabled={rowDisabled || pending}
                          />
                        ) : null}

                        <button
                          type="button"
                          onClick={() => {
                            void applyFieldPatch(row);
                          }}
                          disabled={rowDisabled || pending}
                        >
                          {pending ? "Applying..." : "Apply"}
                        </button>
                      </div>
                      {successByField[row.path] ? (
                        <p className="patch-status ok">{successByField[row.path]}</p>
                      ) : null}
                      {errorByField[row.path] ? (
                        <p className="patch-status err">{errorByField[row.path]}</p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}
    </Panel>
  );
}
