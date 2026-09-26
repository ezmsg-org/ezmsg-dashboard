import { useEffect, useState } from "react";
import { validConnection, type Draft, type ExternalSource } from "./document";

function nodeLabel(draft: Draft, id: string) {
  const node = draft.nodes.find(n => n.id === id);
  if (!node) return id;
  if (node.name) return node.name;
  const peers = draft.nodes.filter(n => n.component.name === node.component.name);
  return node.component.name + (peers.length > 1 ? ` (${peers.findIndex(n => n.id === id) + 1})` : "");
}

export function ConnectionsPanel({ draft, setDraft, selectedId }: {
  draft: Draft; setDraft: (draft: Draft) => void; selectedId: string | null;
}) {
  const [includeExisting, setIncludeExisting] = useState(false);
  const [existing, setExisting] = useState<ExternalSource[]>([]);
  const [discovery, setDiscovery] = useState("Loading running components…");
  const [outputKey, setOutputKey] = useState("");
  const [inputKey, setInputKey] = useState("");
  const hasBindings = Boolean(draft.external_inputs?.length);
  useEffect(() => {
    if (!includeExisting && !hasBindings) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response = await fetch("/api/execution/sources", { signal: controller.signal });
        if (!response.ok) throw new Error("Running components unavailable. Saved connections are retained.");
        const payload = await response.json();
        if (!controller.signal.aborted) {
          setExisting(payload.sources);
          setDiscovery(payload.sources.length ? "" : "No connectable outputs found in other running components.");
        }
      } catch (e) {
        if (!controller.signal.aborted) { setExisting([]); setDiscovery(String(e)); }
      }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 5000);
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [includeExisting, hasBindings]);

  const outputs = draft.nodes.flatMap(n => n.ports.filter(p => p.direction === "output" && !p.settings).map(p => ({
    key: JSON.stringify([n.id, p.name]), node: n.id, port: p.name,
    label: `${nodeLabel(draft, n.id)} · ${p.name}`, type: p.message_type,
  })));
  const inputs = draft.nodes.flatMap(n => n.ports.filter(p => p.direction === "input" && !p.settings).map(p => ({
    key: JSON.stringify([n.id, p.name]), node: n.id, port: p.name,
    label: `${nodeLabel(draft, n.id)} · ${p.name}`, type: p.message_type,
  })));
  useEffect(() => {
    const node = draft.nodes.find(n => n.id === selectedId);
    const port = node?.ports.find(p => p.direction === "input" && !p.settings);
    if (node && port) setInputKey(JSON.stringify([node.id, port.name]));
  }, [selectedId]); // Preserve the user's port choice while editing the graph.
  const output = outputs.find(p => p.key === outputKey);
  const input = inputs.find(p => p.key === inputKey);
  const remote = includeExisting ? existing.find(p => JSON.stringify(["existing", p.topic]) === outputKey) : undefined;
  const edge = output && input ? { source: output.node, sourceHandle: output.port, target: input.node, targetHandle: input.port } : null;
  const canConnect = edge ? validConnection(draft, edge) : Boolean(remote && input && !(draft.external_inputs ?? []).some(b => b.topic === remote.topic && b.target === input.node && b.targetHandle === input.port));
  function connect() {
    if (!canConnect) return;
    if (edge) setDraft({ ...draft, edges: [...draft.edges, { ...edge, id: crypto.randomUUID() }] });
    else if (remote && input) setDraft({ ...draft, external_inputs: [...(draft.external_inputs ?? []), {
      id: `binding:${crypto.randomUUID()}`, topic: remote.topic, target: input.node, targetHandle: input.port,
    }] });
    setOutputKey(""); setInputKey("");
  }
  return <section aria-label="Component connections">
    <h3>Connect components</h3>
    <p>Drag between ports on the canvas, or choose an output and input here.</p>
    <label>Component output<select aria-label="Component output" value={outputKey} onChange={e => setOutputKey(e.target.value)}>
      <option value="">Choose an output</option>
      <optgroup label="In this graph">{outputs.map(p => <option key={p.key} value={p.key}>{p.label} ({p.type})</option>)}</optgroup>
      {includeExisting && <optgroup label="Running elsewhere">{existing.map(p => <option key={p.topic} value={JSON.stringify(["existing", p.topic])}>{p.topic} ({p.message_type})</option>)}</optgroup>}
    </select></label>
    <label>Component input<select aria-label="Component input" value={inputKey} onChange={e => setInputKey(e.target.value)}>
      <option value="">Choose an input</option>{inputs.map(p => <option key={p.key} value={p.key}>{p.label} ({p.type})</option>)}
    </select></label>
    <button className="builder-primary" disabled={!canConnect} onClick={connect}>Connect ports</button>
    {edge && !canConnect && <p>Choose a connection without duplicates or cycles.</p>}
    <div className="builder-existing-option">
      <label><input type="checkbox" checked={includeExisting} onChange={e => setIncludeExisting(e.target.checked)} /> Include components running elsewhere</label>
      {includeExisting && <><p>Choose an output from any stage of an existing pipeline. These components keep their current process ownership.</p>{discovery && <small role="status">{discovery}</small>}</>}
    </div>
    {remote && <p className="builder-boundary-note">This connection crosses a process boundary. Apply restarts only the components owned by this dashboard.</p>}
    <h3>Connections in this graph</h3>
    {!draft.edges.length && !hasBindings && <p>No connections yet. Add components and connect their ports as needed.</p>}
    {draft.edges.map(e => <div className="builder-connection" key={e.id}><span>{nodeLabel(draft, e.source)} · {e.sourceHandle}<br />→ {nodeLabel(draft, e.target)} · {e.targetHandle}</span><button aria-label="Remove connection" onClick={() => setDraft({ ...draft, edges: draft.edges.filter(x => x.id !== e.id) })}>Remove</button></div>)}
    {(draft.external_inputs ?? []).map(b => <div className="builder-connection" key={b.id}><span>{b.topic}<br />→ {nodeLabel(draft, b.target)} · {b.targetHandle}<small>Across processes · running elsewhere{!existing.some(p => p.topic === b.topic) ? " · output unavailable" : ""}</small></span><button aria-label="Remove external connection" onClick={() => setDraft({ ...draft, external_inputs: draft.external_inputs!.filter(x => x.id !== b.id) })}>Remove</button></div>)}
  </section>;
}
