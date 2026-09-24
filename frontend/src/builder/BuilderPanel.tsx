import { useEffect, useRef, useState } from "react";
import { executionSignature, type ExecutionControl } from "./useExecution";
import { emptyDraft, parseDraft, nextNodeName, nameError, type Details, type Draft, type Registration } from "./document";

import { ComponentBrowser } from "./ComponentBrowser";
import { DraftSettings } from "./DraftSettings";
import { ConnectionsPanel } from "./ConnectionsPanel";

export function BuilderPanel({ draft, setDraft, selectedId, select, control }: {
  control: ExecutionControl;
  draft: Draft; setDraft: (draft: Draft) => void; selectedId: string | null; select: (id: string | null) => void;
}) {
  const { execution, busy: executionBusy, error: executionError, command } = control;
  const changed = executionSignature(draft) !== executionSignature(execution?.document ?? null);
  const running = execution?.state === "running";
  const [tab, setTab] = useState<"components" | "configure" | "connections">("components");
  useEffect(() => { if (selectedId) setTab("configure"); }, [selectedId]);
  const [catalog, setCatalog] = useState<Registration[]>([]);
  const [interpreter, setInterpreter] = useState("");
  const [query, setQuery] = useState("");
  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const [nameText, setNameText] = useState("");
  const [settingsText, setSettingsText] = useState("");
  const selected = draft.nodes.find(n => n.id === selectedId);
  useEffect(() => { setNameText(selected?.name ?? ""); }, [selected?.id, selected?.name]);
  const renameError = selected ? nameError(draft, nameText, selected.id) : null;
  useEffect(() => { setSettingsText(JSON.stringify(selected?.settings ?? {}, null, 2)); }, [selected]);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/components", { signal: controller.signal }).then(async r => {
      if (!r.ok) throw new Error("Could not load the component catalog");
      const payload = await r.json(); setCatalog(payload.components); setInterpreter(payload.interpreter);
    }).catch(e => { if (!controller.signal.aborted) setError(String(e)); });
    return () => controller.abort();
  }, []);
  async function inspectComponent(component: Registration) {
    const token = ++request.current;
    setBusy(true); setError(""); setDetails(null);
    try {
      const response = await fetch(`/api/components/${component.id}`);
      if (!response.ok) throw new Error("Could not inspect component");
      const payload = await response.json();
      if (request.current === token) setDetails(payload);
    } catch (e) { if (request.current === token) setError(String(e)); }
    finally { if (request.current === token) setBusy(false); }
  }
  function add() {
    if (!details?.available) return;
    const id = `draft:${crypto.randomUUID()}`;
    const settings = Object.fromEntries((details.settings_fields ?? []).filter(f => "default" in f).map(f => [f.name, f.default]));
    const component = { id: details.id, name: details.name, value: details.value, distribution: details.distribution, version: details.version };
    setDraft({ ...draft, nodes: [...draft.nodes, { id, name: nextNodeName(draft, details.name), component, settings, ports: details.ports ?? [], position: { x: draft.nodes.length * 480, y: 0 } }] });
    select(id); setTab("configure");
  }
  function save() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "ezmsg-graph.json"; anchor.click(); URL.revokeObjectURL(url);
  }
  return <section className="builder-panel" aria-label="Graph builder">
    <h2>Build</h2>
    <p className="builder-intro">Add components, configure them, and connect their ports.</p>
    <p>Execution: {control.available ? execution?.state : "unavailable"}.</p>
    <div className="builder-actions">
      <button disabled={!control.available || !execution || executionBusy || running || !draft.nodes.length} onClick={() => void command("run", draft)}>Run</button>
      <button disabled={!control.available || !execution || executionBusy || !running || !changed || !draft.nodes.length} onClick={() => void command("apply", draft)}>Apply changes</button>
      <button disabled={!control.available || !execution || executionBusy || !running} onClick={() => void command("stop", draft)}>Stop</button>
    </div>
    {running && changed && <div role="status"><p>Apply will stop and replace the entire managed group. Buffers and filter state reset; samples may be lost.</p><strong>Components that will stop/restart:</strong><ul>{execution?.document?.nodes.map(n => <li key={n.id}>{n.name ?? n.component.name}{draft.nodes.some(d => d.id === n.id) ? "" : " (removed)"}</li>)}</ul><p>{draft.nodes.filter(n => !execution?.runtime_addresses[n.id]).length} new components will start.</p></div>}
    {executionBusy && <p role="status">Updating managed execution…</p>}
    {(executionError || execution?.error) && <p role="alert">{executionError || execution?.error}</p>}
    {execution?.state === "failed" && execution.logs?.length ? <details><summary>Execution log</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{execution.logs.join("\n")}</pre></details> : null}
    {execution?.document && <button onClick={() => { setDraft(execution.document!); select(null); setTab("components"); }}>Restore last applied graph</button>}
    <details className="builder-document"><summary>Graph document</summary><div className="builder-actions"><button onClick={save}>Save graph</button><label>Load graph<input aria-label="Load graph" type="file" accept=".json" onChange={async e => {
      const file = e.target.files?.[0]; if (!file) return;
      try { const next = parseDraft(await file.text()); setDraft(next); select(null); setTab("components"); setError(""); } catch (err) { setError(String(err)); }
      e.target.value = "";
    }} /></label><button onClick={() => { setDraft(emptyDraft()); select(null); setTab("components"); }}>New graph</button></div></details>
    {error && <p role="alert">{error}</p>}
    <div className="builder-tabs" role="tablist" aria-label="Build tools">
      <button role="tab" aria-selected={tab === "components"} onClick={() => setTab("components")}>Components</button>
      <button role="tab" aria-selected={tab === "configure"} disabled={!selected} onClick={() => setTab("configure")}>Configure</button>
      <button role="tab" aria-selected={tab === "connections"} onClick={() => setTab("connections")}>Connections</button>
    </div>
    {tab === "configure" && selected && <section className="builder-selection"><h3>{selected.name ?? selected.component.name}</h3><small>{selected.component.name}</small>
      <label>Component name<input aria-label="Component name" value={nameText} onChange={e => setNameText(e.target.value)} maxLength={64} aria-invalid={Boolean(renameError)} /></label>
      {renameError && <small>{renameError}</small>}
      <button disabled={Boolean(renameError) || nameText === selected.name} onClick={() => {
        if (nameError(draft, nameText, selected.id)) return;
        setDraft({ ...draft, nodes: draft.nodes.map(n => n.id === selected.id ? { ...n, name: nameText } : n) });
      }}>Rename component</button>
      <p>Names are case-sensitive and unique within this graph. Apply a rename to update a running component.</p>
      <DraftSettings node={selected} initialDetails={details} update={settings => {
        setDraft({ ...draft, nodes: draft.nodes.map(n => n.id === selected.id ? { ...n, settings } : n) });
      }} />
      <details><summary>Advanced settings JSON</summary>
      <label>Settings (JSON)<textarea aria-label="Draft settings" value={settingsText} onChange={e => setSettingsText(e.target.value)} rows={8} /></label>
      <button onClick={() => { try {
        const settings = JSON.parse(settingsText);
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Settings must be a JSON object");
        setDraft({ ...draft, nodes: draft.nodes.map(n => n.id === selectedId ? { ...n, settings } : n) }); setError("");
      } catch (err) { setError(String(err)); } }}>Update draft settings</button></details>
      <button onClick={() => { setDraft({ ...draft, nodes: draft.nodes.filter(n => n.id !== selectedId), edges: draft.edges.filter(e => e.source !== selectedId && e.target !== selectedId), external_inputs: draft.external_inputs?.filter(b => b.target !== selectedId) }); select(null); setTab("components"); }}>Remove node</button>
      <h4>Ports</h4><ul>{selected.ports.filter(p => !p.settings).map(p => <li key={p.name}>{p.direction}: {p.name}<small>{p.message_type}</small></li>)}</ul>
      <button onClick={() => setTab("connections")}>Edit connections</button>
      <p>Run and Apply validate settings and declared message types in Python. Axis shapes and scientific-data constraints still depend on the components.</p>
    </section>}
    {tab === "components" && <>
    {!draft.nodes.length && <div className="builder-empty"><h3>Start your graph</h3><p>Add any registered Unit or Collection. For example, add lsl.LSLInletUnit and processing components to build a complete pipeline here.</p></div>}
    <h3>Components</h3><small title={interpreter}>{interpreter || "Loading environment…"}</small>
    <input aria-label="Search components" placeholder="Search components, extensions or modules" value={query} onChange={e => setQuery(e.target.value)} />
    <ComponentBrowser catalog={catalog} query={query} selectedId={details?.id} inspect={component => void inspectComponent(component)} />
    {busy && <p role="status">Inspecting component…</p>}
    {details && <section><h3>{details.name}</h3>{!details.available ? <p role="alert">Unavailable: {details.error}</p> : <>
      <p className="component-description">{details.description}</p>
      <ul>{details.ports?.map(p => <li key={p.name}>{p.direction}: {p.name}<small>{p.message_type}</small></li>)}</ul>
      <p>Required settings: {details.settings_fields?.filter(f => f.required).map(f => f.name).join(", ") || "none"}</p>
      {details.schema_error && <p>Full settings schema unavailable; field metadata is available.</p>}
      <button onClick={add}>Add to draft</button>
    </>}</section>}
    </>}
    {tab === "connections" && <ConnectionsPanel draft={draft} setDraft={setDraft} selectedId={selectedId} />}
    <details className="builder-ownership"><summary>Execution & ownership</summary>
      <p>New Units run together in one process by default, including acquisition and processing. Collections retain their declared process layout.</p>
      <p className="managed-legend">Striped components belong to this dashboard. Apply restarts this group. Components running elsewhere retain their process ownership.</p>
    </details>
  </section>;
}
