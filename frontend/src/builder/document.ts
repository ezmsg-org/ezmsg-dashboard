export type Port = { name: string; direction: "input" | "output" | "unknown"; message_type: string; type_resolved: boolean; settings: boolean };
export type Registration = { id: string; name: string; value: string; distribution: string; version: string };
export type Details = Registration & { available: boolean; error?: string; description?: string; kind?: string; ports?: Port[]; settings_fields?: { name: string; required: boolean; type?: string; default?: unknown }[]; json_schema?: unknown; schema_error?: string };
export type DraftNode = { id: string; name?: string; component: Registration; ports: Port[]; position: { x: number; y: number }; settings: Record<string, unknown> };
export type DraftEdge = { id: string; source: string; sourceHandle: string; target: string; targetHandle: string };
export type ExternalInput = { id: string; topic: string; target: string; targetHandle: string };
export type ExternalSource = { topic: string; message_type: string };
export type Draft = { version: 1; nodes: DraftNode[]; edges: DraftEdge[]; external_inputs?: ExternalInput[] };
export const emptyDraft = (): Draft => ({ version: 1, nodes: [], edges: [] });

export function nameError(draft: Draft, name: string, nodeId?: string): string | null {
  if (typeof name !== "string" || name.length > 64 || !/^[A-Za-z_]/.test(name) || /[^A-Za-z0-9_]/.test(name)) return "Use 1–64 letters, digits or underscores; start with a letter or underscore.";
  if (draft.nodes.some(n => n.id !== nodeId && n.name === name)) return "That name is already used in this graph.";
  return null;
}

export function nextNodeName(draft: Draft, componentName: string): string {
  const base = (componentName.split(".").pop() || "Unit").replace(/[^A-Za-z0-9_]/g, "_").replace(/^[0-9]/, "_$&").slice(0, 55);
  let name = base, suffix = 2;
  while (draft.nodes.some(n => n.name === name)) name = `${base}_${suffix++}`;
  return name;
}

export function validConnection(draft: Draft, edge: Omit<DraftEdge, "id">): boolean {
  const source = draft.nodes.find(n => n.id === edge.source)?.ports.find(p => p.name === edge.sourceHandle);
  const target = draft.nodes.find(n => n.id === edge.target)?.ports.find(p => p.name === edge.targetHandle);
  if (!source || !target || source.direction !== "output" || target.direction !== "input" || target.settings) return false;
  if (edge.source === edge.target || draft.edges.some(e => e.source === edge.source && e.target === edge.target && e.sourceHandle === edge.sourceHandle && e.targetHandle === edge.targetHandle)) return false;
  // This is structural validation only. Python must validate message compatibility before execution.
  const pending = [edge.target], visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === edge.source) return false;
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...draft.edges.filter(e => e.source === id).map(e => e.target));
  }
  return true;
}

export function parseDraft(text: string): Draft {
  const value = JSON.parse(text) as Draft;
  if (value?.version !== 1 || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw new Error("Unsupported graph document");
  const ids = new Set<string>();
  for (const n of value.nodes) {
    if (typeof n.id !== "string" || !n.id.startsWith("draft:") || ids.has(n.id) ||
        !n.component || [n.component.id, n.component.name, n.component.value, n.component.distribution, n.component.version].some(x => typeof x !== "string") ||
        !Number.isFinite(n.position?.x) || !Number.isFinite(n.position?.y) ||
        !n.settings || typeof n.settings !== "object" || Array.isArray(n.settings) || !Array.isArray(n.ports)) throw new Error("Invalid draft node");
    if (n.name !== undefined && nameError(value, n.name, n.id)) throw new Error("Invalid or duplicate component name");
    ids.add(n.id);
    const ports = new Set<string>();
    for (const p of n.ports) {
      if (typeof p.name !== "string" || ports.has(p.name) || !["input", "output", "unknown"].includes(p.direction) || typeof p.message_type !== "string") throw new Error("Invalid draft port");
      ports.add(p.name);
    }
  }
  const checked: Draft = { ...value, edges: [] };
  const edgeIds = new Set<string>();
  for (const e of value.edges) {
    if (typeof e.id !== "string" || edgeIds.has(e.id) || !validConnection(checked, e)) throw new Error("Invalid draft connection");
    edgeIds.add(e.id); checked.edges.push(e);
  }
  if (value.external_inputs !== undefined && !Array.isArray(value.external_inputs)) throw new Error("Invalid external connections");
  const externalKeys = new Set<string>();
  for (const b of value.external_inputs ?? []) {
    const port = value.nodes.find(n => n.id === b.target)?.ports.find(p => p.name === b.targetHandle);
    const key = JSON.stringify([b.topic, b.target, b.targetHandle]);
    if (typeof b.id !== "string" || edgeIds.has(b.id) || typeof b.topic !== "string" || !b.topic || !port || port.direction !== "input" || port.settings || externalKeys.has(key)) throw new Error("Invalid external connection");
    edgeIds.add(b.id); externalKeys.add(key);
  }
  return value;
}
