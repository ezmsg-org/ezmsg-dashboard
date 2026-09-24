import { useEffect, useMemo, useState } from "react";
import { SettingsPanel } from "../components/SettingsPanel";
import type { SettingsSchemaField, SettingsValuePayload } from "../types/api";
import type { Details, DraftNode } from "./document";

type Schema = Record<string, unknown>;
const object = (value: unknown): Schema => value && typeof value === "object" && !Array.isArray(value) ? value as Schema : {};

/** Translate Pydantic JSON Schema to the same field metadata used by Monitor. */
export function draftFields(details: Details): SettingsSchemaField[] {
  const root = object(details.json_schema);
  function resolve(value: unknown): Schema {
    const schema = object(value);
    if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) return schema;
    const target = schema.$ref.slice(2).split("/").reduce<unknown>((current, key) => object(current)[key.replace(/~1/g, "/").replace(/~0/g, "~")], root);
    return { ...object(target), ...schema };
  }
  return (details.settings_fields ?? []).map(field => {
    const property = resolve(object(root.properties)[field.name]);
    const alternatives = Array.isArray(property.anyOf) ? property.anyOf.map(resolve) : [property];
    const nonNull = alternatives.filter(s => s.type !== "null");
    const schema = nonNull.length === 1 ? { ...nonNull[0], ...property, type: nonNull[0].type } : property;
    const nullable = alternatives.some(s => s.type === "null") || /none|optional/i.test(field.type ?? "");
    // Compound unions and containers stay JSON; never guess a primitive from a nested type name.
    const type = typeof schema.type === "string" ? schema.type : nonNull.length > 1 ? "object" : field.type ?? "object";
    return {
      name: field.name, field_type: type, required: field.required,
      default: field.default, nullable,
      description: [typeof property.description === "string" ? property.description : null, field.required ? "Required" : null].filter(Boolean).join(" · ") || null,
      bounds: typeof schema.minimum === "number" || typeof schema.maximum === "number"
        ? [typeof schema.minimum === "number" ? schema.minimum : null, typeof schema.maximum === "number" ? schema.maximum : null] : null,
      choices: Array.isArray(schema.enum) ? schema.enum : "const" in schema ? [schema.const] : null,
      widget_hint: null,
    };
  });
}

export function DraftSettings({ node, initialDetails, update }: {
  node: DraftNode; initialDetails: Details | null; update: (settings: Record<string, unknown>) => void;
}) {
  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setError(""); setDetails(null);
    if (initialDetails?.id === node.component.id) { setDetails(initialDetails); return; }
    const controller = new AbortController();
    fetch(`/api/components/${node.component.id}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Could not load settings schema; use JSON below.");
      setDetails(await response.json());
    }).catch(err => { if (!controller.signal.aborted) setError(String(err)); });
    return () => controller.abort();
  }, [node.component.id, initialDetails]);
  const fields = useMemo(() => details ? draftFields(details) : [], [details]);
  const value: SettingsValuePayload = {
    repr_value: node.settings, structured_value: node.settings, serialized_present: false,
    patchable: true, component_name: node.name ?? node.component.name, component_type: node.component.name,
    settings_schema: { provider: "pydantic", settings_type: node.component.name, fields },
  };
  return <>
    <h4>Settings</h4>
    <p>Save each edited field to the draft, then Run or Apply changes to use it.</p>
    {error && <p role="alert">{error}</p>}
    {details?.schema_error && <p>Full schema unavailable; using field metadata. Complex values can be edited as JSON.</p>}
    {details && fields.length > 0 && <SettingsPanel key={node.id} draftMode settings={{ [node.id]: value }} focusComponentAddress={node.id}
      patchSettingField={async (address, path, updated) => {
        const settings = { ...node.settings, [path]: updated };
        update(settings);
        return { component_address: address, field_path: path, updated_value: { ...value, structured_value: settings } };
      }} />}
    {details?.available && fields.length === 0 && <p>This component has no configurable settings.</p>}
    {details && !details.available && <p role="alert">Settings unavailable: {details.error}</p>}
    {!details && !error && <p role="status">Loading settings…</p>}
  </>;
}
