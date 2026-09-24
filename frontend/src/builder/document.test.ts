import { describe, it, expect } from "vitest";
import { parseDraft, validConnection, nameError, nextNodeName, type Draft } from "./document";
const draft: Draft = { version: 1, nodes: ["a", "b", "c"].map(id => ({
  id: `draft:${id}`, component: { id, name: id, value: `missing:${id}`, distribution: "missing", version: "1" },
  settings: {}, position: { x: 0, y: 0 }, ports: [
    { name: "in", direction: "input", message_type: "int", type_resolved: true, settings: false },
    { name: "out", direction: "output", message_type: "int", type_resolved: true, settings: false },
  ],
})), edges: [{ id: "ab", source: "draft:a", sourceHandle: "out", target: "draft:b", targetHandle: "in" }] };
describe("draft documents", () => {
  it("preserves unavailable registrations when loading", () => expect(parseDraft(JSON.stringify(draft))).toEqual(draft));
  it("rejects cycles and invalid port directions", () => {
    expect(validConnection(draft, { source: "draft:b", sourceHandle: "out", target: "draft:a", targetHandle: "in" })).toBe(false);
    expect(validConnection(draft, { source: "draft:b", sourceHandle: "in", target: "draft:c", targetHandle: "in" })).toBe(false);
    expect(validConnection(draft, { source: "draft:b", sourceHandle: "out", target: "draft:c", targetHandle: "in" })).toBe(true);
  });
  it("rejects dangling edges and duplicate identities on import", () => {
    expect(() => parseDraft(JSON.stringify({ ...draft, nodes: draft.nodes.slice(1) }))).toThrow();
    expect(() => parseDraft(JSON.stringify({ ...draft, nodes: [...draft.nodes, draft.nodes[0]] }))).toThrow();
  });
});

import { executionSignature } from "./useExecution";
it("layout edits do not require an execution restart", () => {
  const moved = { ...draft, nodes: draft.nodes.map(n => ({ ...n, position: { x: 99, y: 100 } })) };
  expect(executionSignature(moved)).toBe(executionSignature(draft));
  const configured = { ...draft, nodes: draft.nodes.map(n => ({ ...n, settings: { gain: 2 } })) };
  expect(executionSignature(configured)).not.toBe(executionSignature(draft));
});

it("preserves external bindings and includes them in execution changes", () => {
  const bound = { ...draft, external_inputs: [{ id: "ext", topic: "source/OUTPUT", target: "draft:a", targetHandle: "in" }] };
  expect(parseDraft(JSON.stringify(bound))).toEqual(bound);
  expect(executionSignature(bound)).not.toBe(executionSignature(draft));
  expect(() => parseDraft(JSON.stringify({ ...bound, external_inputs: [{ ...bound.external_inputs[0], targetHandle: "out" }] }))).toThrow();
  expect(() => parseDraft(JSON.stringify({ ...bound, external_inputs: [...bound.external_inputs, ...bound.external_inputs] }))).toThrow();
});

it("allocates unique names and preserves wiring through renames", () => {
  const named = { ...draft, nodes: draft.nodes.map((n, i) => ({ ...n, name: i ? `Filter_${i + 1}` : "Filter" })) };
  expect(nextNodeName(named, "sigproc.Filter")).toBe("Filter_4");
  expect(nameError(named, "Filter", "draft:b")).toContain("already used");
  expect(nameError(named, "root/child", "draft:b")).not.toBeNull();
  const renamed = { ...named, nodes: named.nodes.map(n => n.id === "draft:b" ? { ...n, name: "Lowpass" } : n) };
  expect(parseDraft(JSON.stringify(renamed)).edges).toEqual(draft.edges);
  expect(executionSignature(renamed)).not.toBe(executionSignature(named));
  expect(() => parseDraft(JSON.stringify({ ...named, nodes: named.nodes.map(n => ({ ...n, name: "same" })) }))).toThrow();
});
