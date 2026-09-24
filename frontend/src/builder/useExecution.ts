import { useCallback, useEffect, useRef, useState } from "react";
import type { Draft } from "./document";

export type Execution = {
  logs?: string[];
  state: "stopped" | "running" | "failed";
  error: string | null;
  revision: number;
  root_name: string;
  document: Draft | null;
  runtime_addresses: Record<string, string>;
};
export function executionSignature(draft: Draft | null): string {
  if (!draft) return "";
  return JSON.stringify({
    nodes: draft.nodes.map(n => ({ id: n.id, name: n.name, component: n.component, settings: n.settings })).sort((a, b) => a.id.localeCompare(b.id)),
    external_inputs: (draft.external_inputs ?? []).map(({ topic, target, targetHandle }) => ({ topic, target, targetHandle })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    edges: draft.edges.map(({ source, sourceHandle, target, targetHandle }) => ({ source, sourceHandle, target, targetHandle })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
}
export function useExecution() {
  const fixtureMode = new URLSearchParams(window.location.search).has("fixture");
  const [execution, setExecution] = useState<Execution | null>(null);
  const [error, setError] = useState("");
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const accept = useCallback((next: Execution) => {
    setExecution(previous => !previous || next.root_name !== previous.root_name || next.revision >= previous.revision ? next : previous);
  }, []);
  useEffect(() => {
    if (fixtureMode) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch("/api/execution");
        if (!response.ok) throw new Error("Execution service unavailable");
        const next = await response.json();
        if (active) { accept(next); setAvailable(true); }
      } catch { if (active) setAvailable(false); }
      if (active) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [accept, fixtureMode]);
  async function command(action: "run" | "apply" | "stop", draft: Draft) {
    if (!execution || !available || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const response = await fetch(`/api/execution/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected_revision: execution.revision, ...(action === "stop" ? {} : { document: draft }) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : JSON.stringify(result.detail));
      accept(result);
    } catch (e) { setError(String(e)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return { execution, error, busy, command, available };
}
export type ExecutionControl = ReturnType<typeof useExecution>;
