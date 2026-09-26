import { useMemo, useState } from "react";
import type { Registration } from "./document";

export type CatalogGroup = { name: string; path: string; count: number; groups: CatalogGroup[]; components: Registration[] };
export function catalogTree(catalog: Registration[], query: string): CatalogGroup[] {
  const root: CatalogGroup = { name: "", path: "", count: 0, groups: [], components: [] };
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const component of catalog) {
    if (!terms.every(term => `${component.name} ${component.distribution} ${component.value}`.toLowerCase().includes(term))) continue;
    const module = component.value.split(":")[0].split(".");
    const extension = component.distribution.replace(/^ezmsg[-_.]/, "").replace(/-/g, "_");
    if (module[0] === "ezmsg" && module[1] === extension) module.splice(0, 2);
    const path = [component.distribution, ...module.filter(part => part !== "__init__")];
    let group = root;
    for (const name of path) {
      let child = group.groups.find(g => g.name === name);
      if (!child) { child = { name, path: `${group.path}/${name}`, count: 0, groups: [], components: [] }; group.groups.push(child); }
      child.count++; group = child;
    }
    group.components.push(component);
  }
  function sort(group: CatalogGroup) {
    group.groups.sort((a, b) => a.name.localeCompare(b.name));
    group.components.sort((a, b) => a.name.localeCompare(b.name) || a.value.localeCompare(b.value));
    group.groups.forEach(sort);
  }
  sort(root);
  return root.groups;
}

function Group({ group, searching, initiallyOpen, selectedId, inspect }: {
  group: CatalogGroup; searching: boolean; initiallyOpen: boolean; selectedId?: string;
  inspect: (component: Registration) => void;
}) {
  const [expanded, setExpanded] = useState(initiallyOpen);
  const open = searching || expanded;
  return <li>
    <button className="component-group" aria-expanded={open} onClick={() => setExpanded(!expanded)}>
      <span aria-hidden="true">{open ? "▾" : "▸"}</span> {group.name} <span className="component-count">{group.count}</span>
    </button>
    {open && <ul>
      {group.groups.map(child => <Group key={child.path} group={child} searching={searching} initiallyOpen={initiallyOpen} selectedId={selectedId} inspect={inspect} />)}
      {group.components.map(component => <li key={component.id}><button className="component-entry" aria-label={component.name}
        aria-pressed={selectedId === component.id} title={`${component.value}\n${component.distribution} ${component.version}`}
        onClick={() => inspect(component)}>{component.value.split(":")[1] ?? component.name}<small>{component.version}</small></button></li>)}
    </ul>}
  </li>;
}

export function ComponentBrowser({ catalog, query, selectedId, inspect }: {
  catalog: Registration[]; query: string; selectedId?: string; inspect: (component: Registration) => void;
}) {
  const groups = useMemo(() => catalogTree(catalog, query), [catalog, query]);
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  return <>
    <p className="muted">{total} components in {groups.length} extensions</p>
    <nav className="component-browser" aria-label="Component catalog">
      <ul>{groups.map(group => <Group key={group.path} group={group} searching={Boolean(query.trim())}
        initiallyOpen={catalog.length <= 12} selectedId={selectedId} inspect={inspect} />)}</ul>
      {!total && <p>{catalog.length ? "No matching components." : "No registered components found in this environment."}</p>}
    </nav>
  </>;
}
