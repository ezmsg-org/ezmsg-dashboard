import { useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  ControlButton,
  Controls,
  MarkerType,
  MiniMap,
  Position,
  type ReactFlowInstance,
  type Edge,
  type Node,
} from "reactflow";
import "reactflow/dist/style.css";

import { Panel } from "./Panel";
import type { GraphSnapshotPayload, ProfilingSnapshotPayload } from "../types/api";
import type { TopologyChangedEnvelope } from "../types/events";

export type TopologyEntitySelection =
  | {
      kind: "unit";
      unitAddress: string;
    }
  | {
      kind: "publisher";
      streamAddress: string;
      unitAddress: string | null;
    }
  | {
      kind: "subscriber";
      streamAddress: string;
      unitAddress: string | null;
    }
  | {
      kind: "collection";
      collectionAddress: string;
    };

type TopologyPanelProps = {
  graphSnapshot: GraphSnapshotPayload | null;
  profilingSnapshot?: ProfilingSnapshotPayload | null;
  recentEvents: TopologyChangedEnvelope[];
  immersive?: boolean;
  showLegend?: boolean;
  showMiniMap?: boolean;
  defaultLayout?: LayoutMode;
  edgeConnectorStyle?: "curved" | "orthogonal" | "smooth";
  autoFitOnLayoutScopeChange?: boolean;
  autoFocusOnSelection?: boolean;
  focusSelection?: TopologyEntitySelection | null;
  focusRequestId?: number;
  onEntitySelect?: (selection: TopologyEntitySelection | null) => void;
};
type LayoutMode = "tb" | "lr";

type AnyRecord = Record<string, unknown>;

type StreamDirection = "input" | "output" | "unknown";
type FlowData = { nodes: Node[]; edges: Edge[] };

type UnitComponent = {
  address: string;
  name: string;
  componentType: string;
  streams: Array<{
    name: string;
    address: string;
    direction: StreamDirection;
    msgType: string | null;
    collectionKind: "topic" | "relay" | null;
  }>;
  tasks: Array<{
    name: string;
    subscribes: string | null;
    publishes: string[];
  }>;
};

type CollectionComponent = {
  address: string;
  name: string;
  componentType: string;
  streams: Array<{
    name: string;
    address: string;
    direction: StreamDirection;
    msgType: string | null;
    collectionKind: "topic" | "relay" | null;
  }>;
  children: string[];
};

const UNIT_WIDTH = 320;
const MIN_UNIT_HEIGHT = 120;
const RANK_Y_GAP = 88;
const RANK_X_GAP = 120;
const OWNER_X_GAP = 72;
const OWNER_Y_GAP = 58;
const STREAM_NODE_WIDTH = 100;
const STREAM_NODE_HEIGHT = 30;
const ORPHAN_NODE_WIDTH = 240;
const COLLECTION_NODE_WIDTH = 300;
const COLLECTION_NODE_HEIGHT = 168;
const COLLECTION_NODE_HEADER_HEIGHT = 104;
const COLLECTION_SCOPE_HEADER_HEIGHT = 136;
const COLLECTION_SCOPE_STREAM_TOP = 96;
const COLLECTION_SCOPE_BOTTOM_PADDING = 58;
const UNIT_NODE_HEADER_HEIGHT = 62;
const COLLECTION_BORDER = ["#94a3b8", "#60a5fa", "#22d3ee", "#34d399"];
const COLLECTION_BG = [
  "rgba(226, 232, 240, 0.28)",
  "rgba(219, 234, 254, 0.28)",
  "rgba(207, 250, 254, 0.28)",
  "rgba(209, 250, 229, 0.24)",
];

function graphEdgeCount(graph: Record<string, string[]>): number {
  return Object.values(graph).reduce((total, targets) => total + targets.length, 0);
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null;
}

function streamDirection(stream: AnyRecord): StreamDirection {
  const hasInputHints = "leaky" in stream || "max_queue" in stream;
  if (hasInputHints) {
    return "input";
  }
  const hasOutputHints =
    "num_buffers" in stream
    || "buf_size" in stream
    || "force_tcp" in stream
    || "host" in stream
    || "port" in stream;
  if (hasOutputHints) {
    return "output";
  }
  const name = typeof stream.name === "string" ? stream.name.toUpperCase() : "";
  const address = typeof stream.address === "string" ? stream.address.toUpperCase() : "";
  if (name.includes("INPUT") || address.includes("/INPUT")) {
    return "input";
  }
  if (name.includes("OUTPUT") || address.includes("/OUTPUT")) {
    return "output";
  }
  return "unknown";
}

function truncate(text: string, max = 40): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function friendlyAddressLabel(address: string): string {
  const pieces = address.split("/");
  if (pieces.length <= 3) {
    return address;
  }
  return `${pieces[pieces.length - 2]}/${pieces[pieces.length - 1]}`;
}

function shortType(componentType: string): string {
  const parts = componentType.split(".");
  return parts[parts.length - 1] || componentType;
}

function streamDisplayName(name: string, address: string): string {
  const normalized = name
    .replace(/^INPUT_/, "")
    .replace(/^OUTPUT_/, "")
    .replace(/^TOPIC_/, "");
  const compact = normalized.length > 0 ? normalized : friendlyAddressLabel(address);
  const parts = compact.split("/");
  const lastToken = parts.length > 0 ? parts[parts.length - 1] : compact;
  const output = lastToken.toUpperCase();
  if (output.length <= 18) {
    return output;
  }
  return output.slice(0, 18);
}

function compactMsgType(msgType: string | null): string | null {
  if (!msgType) {
    return null;
  }
  const normalized = msgType.replace(/^builtins\./, "");
  const parts = normalized.split(".");
  const short = parts.length > 0 ? parts[parts.length - 1] : normalized;
  if (short.length <= 16) {
    return short;
  }
  return `${short.slice(0, 15)}…`;
}

function compactCollectionAddress(address: string): string {
  const parts = address.split("/");
  if (parts.length <= 2) {
    return address;
  }
  return parts.slice(Math.max(0, parts.length - 3)).join("/");
}

function estimateCollectionHeaderMinWidth(
  collectionName: string,
  componentType: string
): number {
  const nameWidth = Math.min(176, Math.max(104, collectionName.length * 7.4));
  const typeWidth = Math.min(
    112,
    Math.max(66, shortType(componentType).length * 6.1 + 14)
  );
  const openButtonWidth = 82;
  const innerPadding = 18;
  return nameWidth + typeWidth + openButtonWidth + innerPadding;
}

function streamAddressWithoutEndpoint(address: string): string {
  return address.split(":")[0] ?? address;
}

function belongsToCollection(
  address: string,
  collectionAddress: string,
  parentByAddress: Map<string, string>
): boolean {
  if (address === collectionAddress) {
    return true;
  }
  const seen = new Set<string>();
  let current: string | undefined = address;
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = parentByAddress.get(current);
    if (!parent) {
      return false;
    }
    if (parent === collectionAddress) {
      return true;
    }
    current = parent;
  }
  return false;
}

function streamLabelClassName(
  stream: UnitComponent["streams"][number],
  className: "is-input" | "is-output" | "is-unknown",
  ownerKind: "unit" | "collection"
): string {
  if (ownerKind === "collection" && stream.collectionKind) {
    return "mono topology-stream-label is-collection";
  }
  return `mono topology-stream-label ${className}`;
}

function streamNodeVisualStyle(
  stream: UnitComponent["streams"][number],
  className: "is-input" | "is-output" | "is-unknown",
  ownerKind: "unit" | "collection"
): {
  border: string;
  background: string;
  color: string;
  borderRadius: number;
} {
  if (ownerKind === "collection" && stream.collectionKind) {
    if (stream.collectionKind === "topic") {
      if (className === "is-output") {
        return {
          border: "1px solid #f28e2b",
          background: "#fff1dd",
          color: "#8a4f10",
          borderRadius: 999,
        };
      }
      if (className === "is-input") {
        return {
          border: "1px solid #f6a44d",
          background: "#fff8ef",
          color: "#8a4f10",
          borderRadius: 999,
        };
      }
      return {
        border: "1px solid #f8b66f",
        background: "#fff8ef",
        color: "#8a4f10",
        borderRadius: 10,
      };
    }
    if (className === "is-output") {
      return {
        border: "1px solid #b07aa1",
        background: "#f8eef5",
        color: "#6f3f66",
        borderRadius: 999,
      };
    }
    if (className === "is-input") {
      return {
        border: "1px solid #c194b7",
        background: "#fbf3f8",
        color: "#6f3f66",
        borderRadius: 999,
      };
    }
    return {
      border: "1px solid #d3accb",
      background: "#fbf3f8",
      color: "#6f3f66",
      borderRadius: 10,
    };
  }

  return {
    border:
      className === "is-input"
        ? "1px solid #c7d2fe"
        : className === "is-output"
          ? "1px solid #7dd3fc"
          : "1px solid #cbd5e1",
    background:
      className === "is-input"
        ? "#eef2ff"
        : className === "is-output"
          ? "#ecfeff"
          : "#f8fafc",
    color: "#1e293b",
    borderRadius: className === "is-unknown" ? 8 : 999,
  };
}

function normalizeStreamToken(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/^INPUT_/, "")
    .replace(/^OUTPUT_/, "")
    .replace(/^TOPIC_/, "");
}

function buildLocalStreamLookup(streams: UnitComponent["streams"]): {
  addressSet: Set<string>;
  withoutEndpointMap: Map<string, string>;
  normalizedNameMap: Map<string, string>;
} {
  const addressSet = new Set<string>();
  const withoutEndpointMap = new Map<string, string>();
  const normalizedNameMap = new Map<string, string>();

  for (const stream of streams) {
    addressSet.add(stream.address);
    const withoutEndpoint = streamAddressWithoutEndpoint(stream.address);
    withoutEndpointMap.set(withoutEndpoint, stream.address);
    normalizedNameMap.set(normalizeStreamToken(stream.name), stream.address);
    normalizedNameMap.set(normalizeStreamToken(streamDisplayName(stream.name, stream.address)), stream.address);
    normalizedNameMap.set(normalizeStreamToken(withoutEndpoint), stream.address);
    const lastAddressToken = withoutEndpoint.split("/").pop();
    if (lastAddressToken) {
      normalizedNameMap.set(normalizeStreamToken(lastAddressToken), stream.address);
    }
  }

  return { addressSet, withoutEndpointMap, normalizedNameMap };
}

function resolveTaskStreamReference(
  value: string | null,
  lookup: ReturnType<typeof buildLocalStreamLookup>
): string | null {
  if (!value) {
    return null;
  }
  if (lookup.addressSet.has(value)) {
    return value;
  }
  if (lookup.withoutEndpointMap.has(value)) {
    return lookup.withoutEndpointMap.get(value) ?? null;
  }

  const withoutEndpoint = value.split(":")[0];
  if (lookup.withoutEndpointMap.has(withoutEndpoint)) {
    return lookup.withoutEndpointMap.get(withoutEndpoint) ?? null;
  }

  const normalized = normalizeStreamToken(value);
  if (lookup.normalizedNameMap.has(normalized)) {
    return lookup.normalizedNameMap.get(normalized) ?? null;
  }

  const normalizedTail = normalizeStreamToken(withoutEndpoint.split("/").pop() ?? "");
  if (lookup.normalizedNameMap.has(normalizedTail)) {
    return lookup.normalizedNameMap.get(normalizedTail) ?? null;
  }

  for (const address of lookup.addressSet) {
    if (address.startsWith(`${value}:`) || address.startsWith(`${withoutEndpoint}:`)) {
      return address;
    }
  }
  return null;
}

function parseStreamEntries(
  streams: AnyRecord | null,
  collectionKind: "topic" | "relay" | null = null
): Array<{
  name: string;
  address: string;
  direction: StreamDirection;
  msgType: string | null;
  collectionKind: "topic" | "relay" | null;
}> {
  if (!streams) {
    return [];
  }
  const out: Array<{
    name: string;
    address: string;
    direction: StreamDirection;
    msgType: string | null;
    collectionKind: "topic" | "relay" | null;
  }> = [];
  for (const [streamName, streamValue] of Object.entries(streams)) {
    if (!isRecord(streamValue) || typeof streamValue.address !== "string") {
      continue;
    }
    out.push({
      name: streamName,
      address: streamValue.address,
      direction: streamDirection(streamValue),
      msgType: typeof streamValue.msg_type === "string" ? streamValue.msg_type : null,
      collectionKind,
    });
  }
  out.sort((a, b) => a.address.localeCompare(b.address));
  return out;
}

function classifyComponents(graphSnapshot: GraphSnapshotPayload): {
  units: Map<string, UnitComponent>;
  collections: Map<string, CollectionComponent>;
} {
  const componentRecords = new Map<string, AnyRecord>();
  for (const session of Object.values(graphSnapshot.sessions)) {
    const metadata = isRecord(session.metadata) ? session.metadata : null;
    const components = metadata && isRecord(metadata.components) ? metadata.components : null;
    if (!components) {
      continue;
    }
    for (const [address, value] of Object.entries(components)) {
      if (!isRecord(value) || componentRecords.has(address)) {
        continue;
      }
      componentRecords.set(address, value);
    }
  }

  const units = new Map<string, UnitComponent>();
  const collections = new Map<string, CollectionComponent>();

  for (const [address, component] of componentRecords.entries()) {
    const name = typeof component.name === "string" ? component.name : address;
    const componentType =
      typeof component.component_type === "string"
        ? component.component_type
        : "Component";

    const childrenRaw = Array.isArray(component.children)
      ? component.children.filter((value): value is string => typeof value === "string")
      : [];
    if (childrenRaw.length > 0) {
      const collectionStreamMap = new Map<string, {
        name: string;
        address: string;
        direction: StreamDirection;
        msgType: string | null;
        collectionKind: "topic" | "relay" | null;
      }>();
      for (const stream of parseStreamEntries(
        isRecord(component.topics) ? component.topics : null,
        "topic"
      )) {
        collectionStreamMap.set(stream.address, stream);
      }
      for (const stream of parseStreamEntries(
        isRecord(component.relays) ? component.relays : null,
        "relay"
      )) {
        collectionStreamMap.set(stream.address, stream);
      }
      collections.set(address, {
        address,
        name,
        componentType,
        streams: Array.from(collectionStreamMap.values()).sort((a, b) =>
          a.address.localeCompare(b.address)
        ),
        children: childrenRaw,
      });
    }

    const streams = isRecord(component.streams) ? component.streams : null;
    if (!streams) {
      continue;
    }
    const tasksRaw = Array.isArray(component.tasks) ? component.tasks : [];
    const tasks = tasksRaw
      .filter(isRecord)
      .map((task) => {
        if (typeof task.name !== "string") {
          return null;
        }
        const publishes = Array.isArray(task.publishes)
          ? task.publishes.filter(
              (value): value is string => typeof value === "string"
            )
          : [];
        return {
          name: task.name,
          subscribes:
            typeof task.subscribes === "string" ? task.subscribes : null,
          publishes,
        };
      })
      .filter(
        (
          task
        ): task is {
          name: string;
          subscribes: string | null;
          publishes: string[];
        } => task !== null
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    units.set(address, {
      address,
      name,
      componentType,
      streams: parseStreamEntries(streams),
      tasks,
    });
  }

  return { units, collections };
}

function computeRanks(ownerIds: string[], edges: Array<{ from: string; to: string }>): Map<string, number> {
  const rankByOwner = new Map<string, number>();
  for (const ownerId of ownerIds) {
    rankByOwner.set(ownerId, 0);
  }
  const iterations = Math.max(1, ownerIds.length);
  for (let i = 0; i < iterations; i += 1) {
    let changed = false;
    for (const edge of edges) {
      const fromRank = rankByOwner.get(edge.from) ?? 0;
      const toRank = rankByOwner.get(edge.to) ?? 0;
      const next = Math.min(ownerIds.length, fromRank + 1);
      if (next > toRank) {
        rankByOwner.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  return rankByOwner;
}

function visibleComponentAddresses(
  units: Map<string, UnitComponent>,
  collections: Map<string, CollectionComponent>,
  scopeCollectionAddress: string | null
): string[] {
  if (scopeCollectionAddress) {
    const scopeCollection = collections.get(scopeCollectionAddress);
    if (!scopeCollection) {
      return [];
    }
    return scopeCollection.children.filter(
      (address) => units.has(address) || collections.has(address)
    );
  }

  const childAddresses = new Set<string>();
  for (const collection of collections.values()) {
    for (const childAddress of collection.children) {
      childAddresses.add(childAddress);
    }
  }

  const topLevel = [
    ...Array.from(collections.keys()),
    ...Array.from(units.keys()),
  ].filter((address) => !childAddresses.has(address));

  if (topLevel.length > 0) {
    return topLevel;
  }
  return Array.from(units.keys());
}

function buildCollectionParentMap(
  collections: Map<string, CollectionComponent>
): Map<string, string> {
  const parentByAddress = new Map<string, string>();
  for (const [collectionAddress, collection] of collections.entries()) {
    for (const childAddress of collection.children) {
      if (parentByAddress.has(childAddress)) {
        continue;
      }
      parentByAddress.set(childAddress, collectionAddress);
    }
  }
  return parentByAddress;
}

function collectionScopePath(
  collections: Map<string, CollectionComponent>,
  scopeCollectionAddress: string | null
): string[] {
  if (!scopeCollectionAddress || !collections.has(scopeCollectionAddress)) {
    return [];
  }
  const parentByAddress = buildCollectionParentMap(collections);
  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = scopeCollectionAddress;
  while (current && !seen.has(current)) {
    seen.add(current);
    path.push(current);
    current = parentByAddress.get(current);
  }
  return path.reverse();
}

function collectionHasVisibleChildren(
  collectionAddress: string,
  units: Map<string, UnitComponent>,
  collections: Map<string, CollectionComponent>
): boolean {
  const collection = collections.get(collectionAddress);
  if (!collection) {
    return false;
  }
  return collection.children.some(
    (address) => units.has(address) || collections.has(address)
  );
}

function isFinitePosition(value: unknown): value is { x: number; y: number } {
  return (
    typeof value === "object"
    && value !== null
    && typeof (value as { x?: unknown }).x === "number"
    && Number.isFinite((value as { x: number }).x)
    && typeof (value as { y?: unknown }).y === "number"
    && Number.isFinite((value as { y: number }).y)
  );
}

function validateFlowData(flow: FlowData): boolean {
  if (!Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) {
    return false;
  }
  const nodeIds = new Set<string>();
  for (const node of flow.nodes) {
    if (!node || typeof node.id !== "string" || node.id.length === 0) {
      return false;
    }
    if (nodeIds.has(node.id)) {
      return false;
    }
    nodeIds.add(node.id);
    if (!isFinitePosition(node.position)) {
      return false;
    }
  }
  for (const node of flow.nodes) {
    if (typeof node.parentNode === "string" && !nodeIds.has(node.parentNode)) {
      return false;
    }
  }
  for (const edge of flow.edges) {
    if (!edge || typeof edge.source !== "string" || typeof edge.target !== "string") {
      return false;
    }
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      return false;
    }
  }
  return true;
}

function sourceStreamAddressFromEdgeId(edgeId: string): string | null {
  if (!edgeId.startsWith("edge:")) {
    return null;
  }
  if (edgeId.startsWith("edge:internal:")) {
    return null;
  }
  const payload = edgeId.slice("edge:".length);
  const arrowIndex = payload.indexOf("->");
  if (arrowIndex <= 0) {
    return null;
  }
  const source = payload.slice(0, arrowIndex);
  return source.length > 0 ? source : null;
}

function buildFlowData(
  graphSnapshot: GraphSnapshotPayload,
  layoutMode: LayoutMode,
  scopeCollectionAddress: string | null,
  edgeConnectorStyle: "curved" | "orthogonal" | "smooth"
): {
  nodes: Node[];
  edges: Edge[];
} {
  const connectorType =
    edgeConnectorStyle === "orthogonal"
      ? "step"
      : edgeConnectorStyle === "smooth"
        ? "smoothstep"
        : "default";
  const { units, collections } = classifyComponents(graphSnapshot);
  const visibleAddresses = visibleComponentAddresses(
    units,
    collections,
    scopeCollectionAddress
  );

  const visibleUnits = new Map<string, UnitComponent>();
  const visibleCollections = new Map<string, CollectionComponent>();
  for (const address of visibleAddresses) {
    const unit = units.get(address);
    if (unit) {
      visibleUnits.set(address, unit);
      continue;
    }
    const collection = collections.get(address);
    if (collection) {
      visibleCollections.set(address, collection);
    }
  }
  const visibleUnitAddresses = new Set(visibleUnits.keys());
  const visibleCollectionAddresses = new Set(visibleCollections.keys());
  const collectionParentByAddress = buildCollectionParentMap(collections);
  const scopedCollection =
    scopeCollectionAddress ? collections.get(scopeCollectionAddress) ?? null : null;
  const scopedCollectionOwnerId = scopedCollection
    ? `scope:${scopedCollection.address}`
    : null;

  const unitOwnerByStreamAddress = new Map<string, string>();
  const collectionOwnerByStreamAddress = new Map<string, string>();
  for (const unit of units.values()) {
    for (const stream of unit.streams) {
      unitOwnerByStreamAddress.set(stream.address, unit.address);
      unitOwnerByStreamAddress.set(streamAddressWithoutEndpoint(stream.address), unit.address);
    }
  }
  for (const collection of collections.values()) {
    for (const stream of collection.streams) {
      collectionOwnerByStreamAddress.set(stream.address, collection.address);
      collectionOwnerByStreamAddress.set(streamAddressWithoutEndpoint(stream.address), collection.address);
    }
  }

  const canonicalStreamByAlias = new Map<string, string>();
  for (const unit of units.values()) {
    for (const stream of unit.streams) {
      canonicalStreamByAlias.set(stream.address, stream.address);
      canonicalStreamByAlias.set(streamAddressWithoutEndpoint(stream.address), stream.address);
    }
  }
  for (const collection of collections.values()) {
    for (const stream of collection.streams) {
      canonicalStreamByAlias.set(stream.address, stream.address);
      canonicalStreamByAlias.set(streamAddressWithoutEndpoint(stream.address), stream.address);
    }
  }

  const rawEdges: Array<{ from: string; to: string }> = [];
  for (const [fromTopic, toTopics] of Object.entries(graphSnapshot.graph)) {
    for (const toTopic of toTopics) {
      rawEdges.push({
        from: canonicalStreamByAlias.get(fromTopic) ?? fromTopic,
        to: canonicalStreamByAlias.get(toTopic) ?? toTopic,
      });
    }
  }

  const streamOwnerByAddress = new Map<
    string,
    {
      ownerId: string;
      ownerKind:
        | "unit"
        | "collection"
        | "scope_collection"
        | "collection_proxy"
        | "orphan";
    }
  >();
  const registerStreamOwner = (
    streamAddress: string,
    owner: {
      ownerId: string;
      ownerKind:
        | "unit"
        | "collection"
        | "scope_collection"
        | "collection_proxy"
        | "orphan";
    }
  ) => {
    streamOwnerByAddress.set(streamAddress, owner);
    streamOwnerByAddress.set(streamAddressWithoutEndpoint(streamAddress), owner);
  };
  for (const unit of visibleUnits.values()) {
    for (const stream of unit.streams) {
      registerStreamOwner(stream.address, {
        ownerId: `unit:${unit.address}`,
        ownerKind: "unit",
      });
    }
  }
  for (const collection of visibleCollections.values()) {
    for (const stream of collection.streams) {
      registerStreamOwner(stream.address, {
        ownerId: `collection:${collection.address}`,
        ownerKind: "collection",
      });
    }
  }

  const ownedStreams = new Set(streamOwnerByAddress.keys());
  const relevantRawEdges = rawEdges.filter(
    (edge) => ownedStreams.has(edge.from) || ownedStreams.has(edge.to)
  );

  const relevantStreams = new Set<string>(ownedStreams);
  for (const edge of relevantRawEdges) {
    relevantStreams.add(edge.from);
    relevantStreams.add(edge.to);
  }

  const ownerIds = new Set<string>();
  const ownerLabel = new Map<string, string>();
  for (const unit of visibleUnits.values()) {
    const ownerId = `unit:${unit.address}`;
    ownerIds.add(ownerId);
    ownerLabel.set(ownerId, unit.name);
  }
  for (const collection of visibleCollections.values()) {
    const ownerId = `collection:${collection.address}`;
    ownerIds.add(ownerId);
    ownerLabel.set(ownerId, collection.name);
  }
  for (const streamAddress of relevantStreams) {
    if (streamOwnerByAddress.has(streamAddress)) {
      continue;
    }
    const directCollectionOwner = collectionOwnerByStreamAddress.get(streamAddress);
    if (directCollectionOwner && visibleCollectionAddresses.has(directCollectionOwner)) {
      registerStreamOwner(streamAddress, {
        ownerId: `collection:${directCollectionOwner}`,
        ownerKind: "collection",
      });
      continue;
    }
    const directUnitOwner = unitOwnerByStreamAddress.get(streamAddress);
    if (directUnitOwner && visibleUnitAddresses.has(directUnitOwner)) {
      registerStreamOwner(streamAddress, {
        ownerId: `unit:${directUnitOwner}`,
        ownerKind: "unit",
      });
      continue;
    }

    if (scopedCollection && scopedCollectionOwnerId) {
      const scopedMatch =
        (directCollectionOwner
          && belongsToCollection(
            directCollectionOwner,
            scopedCollection.address,
            collectionParentByAddress
          ))
        || (directUnitOwner
          && belongsToCollection(
            directUnitOwner,
            scopedCollection.address,
            collectionParentByAddress
          ));
      if (scopedMatch) {
        registerStreamOwner(streamAddress, {
          ownerId: scopedCollectionOwnerId,
          ownerKind: "scope_collection",
        });
        continue;
      }
    }

    const hiddenOwner = directUnitOwner ?? directCollectionOwner ?? null;
    if (hiddenOwner) {
      let parent = collectionParentByAddress.get(hiddenOwner) ?? null;
      while (parent) {
        if (visibleCollectionAddresses.has(parent)) {
          registerStreamOwner(streamAddress, {
            ownerId: `collection:${parent}`,
            ownerKind: "collection_proxy",
          });
          break;
        }
        parent = collectionParentByAddress.get(parent) ?? null;
      }
      if (streamOwnerByAddress.has(streamAddress)) {
        continue;
      }
    }

    const orphanOwnerId = `orphan:${streamAddress}`;
    registerStreamOwner(streamAddress, {
      ownerId: orphanOwnerId,
      ownerKind: "orphan",
    });
    ownerIds.add(orphanOwnerId);
    ownerLabel.set(orphanOwnerId, friendlyAddressLabel(streamAddress));
  }

  const ownerEdges: Array<{ from: string; to: string }> = [];
  const ownerEdgeIds = new Set<string>();
  for (const edge of relevantRawEdges) {
    const fromOwner = streamOwnerByAddress.get(edge.from)?.ownerId;
    const toOwner = streamOwnerByAddress.get(edge.to)?.ownerId;
    if (
      !fromOwner
      || !toOwner
      || fromOwner === toOwner
      || !ownerIds.has(fromOwner)
      || !ownerIds.has(toOwner)
    ) {
      continue;
    }
    const id = `${fromOwner}->${toOwner}`;
    if (ownerEdgeIds.has(id)) {
      continue;
    }
    ownerEdgeIds.add(id);
    ownerEdges.push({ from: fromOwner, to: toOwner });
  }

  const orderedOwnerIds = Array.from(ownerIds).sort((a, b) => {
    const left = ownerLabel.get(a) ?? a;
    const right = ownerLabel.get(b) ?? b;
    return left.localeCompare(right);
  });
  const rankByOwner = computeRanks(orderedOwnerIds, ownerEdges);
  const ownersByRank = new Map<number, string[]>();
  for (const ownerId of orderedOwnerIds) {
    const rank = rankByOwner.get(ownerId) ?? 0;
    const row = ownersByRank.get(rank);
    if (row) {
      row.push(ownerId);
    } else {
      ownersByRank.set(rank, [ownerId]);
    }
  }

  const ownerSizeById = new Map<string, { width: number; height: number }>();
  for (const unit of visibleUnits.values()) {
    const inputs = unit.streams.filter((stream) => stream.direction === "input").length;
    const outputs = unit.streams.filter((stream) => stream.direction === "output").length;
    const tasks = unit.tasks.length;
    const maxRows = Math.max(1, inputs, outputs, tasks);
    const width = layoutMode === "lr" ? Math.max(356, maxRows * 108 + 72) : Math.max(316, maxRows * 106 + 64);
    const height = layoutMode === "lr" ? Math.max(154, 92 + maxRows * 30) : 216;
    ownerSizeById.set(`unit:${unit.address}`, { width, height });
  }
  for (const collection of visibleCollections.values()) {
    const inputs = collection.streams.filter((stream) => stream.direction === "input").length;
    const outputs = collection.streams.filter((stream) => stream.direction === "output").length;
    const unknown = collection.streams.filter((stream) => stream.direction === "unknown").length;
    const maxRows = Math.max(1, inputs, outputs, unknown);
    const streamDrivenWidth =
      layoutMode === "lr"
        ? Math.max(COLLECTION_NODE_WIDTH, maxRows * 108 + 72)
        : Math.max(300, maxRows * 106 + 64);
    const headerMinWidth = estimateCollectionHeaderMinWidth(
      collection.name,
      collection.componentType
    );
    const width = Math.max(streamDrivenWidth, headerMinWidth);
    const height =
      layoutMode === "lr"
        ? Math.max(COLLECTION_NODE_HEIGHT, 72 + maxRows * 30)
        : 176;
    ownerSizeById.set(`collection:${collection.address}`, { width, height });
  }
  for (const ownerId of orderedOwnerIds) {
    if (ownerSizeById.has(ownerId)) {
      continue;
    }
    ownerSizeById.set(ownerId, { width: ORPHAN_NODE_WIDTH, height: 74 });
  }

  const ownerPosition = new Map<string, { x: number; y: number }>();
  const orderedRanks = Array.from(ownersByRank.keys()).sort((a, b) => a - b);
  if (layoutMode === "tb") {
    let y = 28;
    for (const rank of orderedRanks) {
      const owners = ownersByRank.get(rank) ?? [];
      let x = 24;
      let rowMaxHeight = 0;
      for (const ownerId of owners) {
        const size = ownerSizeById.get(ownerId) ?? { width: UNIT_WIDTH, height: MIN_UNIT_HEIGHT };
        ownerPosition.set(ownerId, { x, y });
        x += size.width + OWNER_X_GAP;
        rowMaxHeight = Math.max(rowMaxHeight, size.height);
      }
      y += rowMaxHeight + RANK_Y_GAP;
    }
  } else {
    let x = 24;
    for (const rank of orderedRanks) {
      const owners = ownersByRank.get(rank) ?? [];
      let y = 28;
      let columnMaxWidth = 0;
      for (const ownerId of owners) {
        const size = ownerSizeById.get(ownerId) ?? { width: UNIT_WIDTH, height: MIN_UNIT_HEIGHT };
        ownerPosition.set(ownerId, { x, y });
        y += size.height + OWNER_Y_GAP;
        columnMaxWidth = Math.max(columnMaxWidth, size.width);
      }
      x += columnMaxWidth + RANK_X_GAP;
    }
  }

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const internalEdgeStyle = {
    stroke: "#475569",
    strokeWidth: 1.5,
  };
  const internalMarker = {
    type: MarkerType.ArrowClosed as const,
    width: 12,
    height: 12,
    color: "#475569",
  };

  if (scopedCollection && scopedCollectionOwnerId) {
    const scopedOwnerIds = orderedOwnerIds.filter(
      (ownerId) => ownerId.startsWith("unit:") || ownerId.startsWith("collection:")
    );
    let minX = 24;
    let minY = 32;
    let maxX = 24 + COLLECTION_NODE_WIDTH;
    let maxY = 32 + COLLECTION_NODE_HEIGHT;
    if (scopedOwnerIds.length > 0) {
      minX = Number.POSITIVE_INFINITY;
      minY = Number.POSITIVE_INFINITY;
      maxX = Number.NEGATIVE_INFINITY;
      maxY = Number.NEGATIVE_INFINITY;
      for (const ownerId of scopedOwnerIds) {
        const pos = ownerPosition.get(ownerId);
        const size = ownerSizeById.get(ownerId);
        if (!pos || !size) {
          continue;
        }
        minX = Math.min(minX, pos.x);
        minY = Math.min(minY, pos.y);
        maxX = Math.max(maxX, pos.x + size.width);
        maxY = Math.max(maxY, pos.y + size.height);
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
        minX = 24;
        minY = 32;
        maxX = 24 + COLLECTION_NODE_WIDTH;
        maxY = 32 + COLLECTION_NODE_HEIGHT;
      }
    }

    const scopePaddingX = 28;
    const scopeHeaderHeight = COLLECTION_SCOPE_HEADER_HEIGHT;
    const scopeBottomPadding = COLLECTION_SCOPE_BOTTOM_PADDING;
    const scopeContentHeight = Math.max(0, maxY - minY);
    const scopePos = {
      x: minX - scopePaddingX,
      y: minY - scopeHeaderHeight,
    };
    const scopeSize = {
      width: Math.max(360, maxX - minX + scopePaddingX * 2),
      height: Math.max(180, scopeContentHeight + scopeHeaderHeight + scopeBottomPadding),
    };

    nodes.push({
      id: scopedCollectionOwnerId,
      position: scopePos,
      sourcePosition: layoutMode === "tb" ? Position.Bottom : Position.Right,
      targetPosition: layoutMode === "tb" ? Position.Top : Position.Left,
      data: {
        label: (
          <div className="topology-collection-label topology-collection-label--scope" title={scopedCollection.address}>
            <span className="topology-title-row">
              <strong>{scopedCollection.name}</strong>
              <span className="topology-unit-type">{shortType(scopedCollection.componentType)}</span>
            </span>
            <span className="mono">{compactCollectionAddress(scopedCollection.address)}</span>
          </div>
        ),
      },
      style: {
        width: scopeSize.width,
        height: scopeSize.height,
        border: `2px dashed ${COLLECTION_BORDER[0]}`,
        borderRadius: 14,
        background: "rgba(226, 232, 240, 0.24)",
        color: "#0f172a",
        padding: 10,
        zIndex: -1,
      },
      draggable: false,
      selectable: false,
    });

    const scopedInputs = scopedCollection.streams.filter((stream) => stream.direction === "input");
    const scopedOutputs = scopedCollection.streams.filter((stream) => stream.direction === "output");
    const scopedUnknown = scopedCollection.streams.filter((stream) => stream.direction === "unknown");
    if (layoutMode === "lr") {
      const rowStep = 30;
      const maxRows = Math.max(1, scopedInputs.length, scopedOutputs.length);
      const blockHeight = maxRows * rowStep;
      const top = Math.max(
        COLLECTION_SCOPE_STREAM_TOP,
        scopeHeaderHeight - blockHeight - 12
      );
      scopedInputs.forEach((stream, index) => {
        const visual = streamNodeVisualStyle(stream, "is-input", "collection");
        nodes.push({
          id: `stream:${stream.address}`,
          parentNode: scopedCollectionOwnerId,
          extent: "parent",
          draggable: false,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          data: {
            label: (
              <span className={streamLabelClassName(stream, "is-input", "collection")} title={stream.address}>
                <span className="topology-stream-name">
                  {truncate(streamDisplayName(stream.name, stream.address), 10)}
                </span>
                {compactMsgType(stream.msgType) ? (
                  <span className="topology-stream-type">[{compactMsgType(stream.msgType)}]</span>
                ) : null}
              </span>
            ),
          },
          position: { x: 12, y: top + index * rowStep },
          style: {
            width: STREAM_NODE_WIDTH,
            height: STREAM_NODE_HEIGHT,
            borderRadius: visual.borderRadius,
            border: visual.border,
            background: visual.background,
            color: visual.color,
            padding: "1px 6px",
          },
        });
      });
      scopedOutputs.forEach((stream, index) => {
        const visual = streamNodeVisualStyle(stream, "is-output", "collection");
        nodes.push({
          id: `stream:${stream.address}`,
          parentNode: scopedCollectionOwnerId,
          extent: "parent",
          draggable: false,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          data: {
            label: (
              <span className={streamLabelClassName(stream, "is-output", "collection")} title={stream.address}>
                <span className="topology-stream-name">
                  {truncate(streamDisplayName(stream.name, stream.address), 10)}
                </span>
                {compactMsgType(stream.msgType) ? (
                  <span className="topology-stream-type">[{compactMsgType(stream.msgType)}]</span>
                ) : null}
              </span>
            ),
          },
          position: {
            x: scopeSize.width - STREAM_NODE_WIDTH - 12,
            y: top + index * rowStep,
          },
          style: {
            width: STREAM_NODE_WIDTH,
            height: STREAM_NODE_HEIGHT,
            borderRadius: visual.borderRadius,
            border: visual.border,
            background: visual.background,
            color: visual.color,
            padding: "1px 6px",
          },
        });
      });
      if (scopedUnknown.length > 0) {
        placeUnitStreamRow(
          scopedCollectionOwnerId,
          scopeSize,
          scopedUnknown,
          56 + Math.max(scopedInputs.length, scopedOutputs.length) * rowStep + 4,
          "is-unknown",
          "collection",
          layoutMode,
          nodes
        );
      }
    } else {
      const topInputY = Math.max(
        COLLECTION_SCOPE_STREAM_TOP,
        scopeHeaderHeight - STREAM_NODE_HEIGHT - 8
      );
      const scopeFooterTop = scopeHeaderHeight + scopeContentHeight;
      const bottomOutputY = Math.min(
        scopeSize.height - STREAM_NODE_HEIGHT - 10,
        scopeFooterTop + Math.max(6, Math.floor((scopeBottomPadding - STREAM_NODE_HEIGHT) / 2))
      );
      placeUnitStreamRow(
        scopedCollectionOwnerId,
        scopeSize,
        scopedInputs,
        topInputY,
        "is-input",
        "collection",
        layoutMode,
        nodes
      );
      placeUnitStreamRow(
        scopedCollectionOwnerId,
        scopeSize,
        scopedOutputs,
        bottomOutputY,
        "is-output",
        "collection",
        layoutMode,
        nodes
      );
      if (scopedUnknown.length > 0) {
        placeUnitStreamRow(
          scopedCollectionOwnerId,
          scopeSize,
          scopedUnknown,
          Math.floor((scopeSize.height - STREAM_NODE_HEIGHT) / 2),
          "is-unknown",
          "collection",
          layoutMode,
          nodes
        );
      }
    }
  }

  for (const collection of visibleCollections.values()) {
    const nodeId = `collection:${collection.address}`;
    const pos = ownerPosition.get(nodeId) ?? { x: 0, y: 0 };
    const size = ownerSizeById.get(nodeId) ?? {
      width: COLLECTION_NODE_WIDTH,
      height: COLLECTION_NODE_HEIGHT,
    };
    nodes.push({
      id: nodeId,
      position: pos,
      sourcePosition: layoutMode === "tb" ? Position.Bottom : Position.Right,
      targetPosition: layoutMode === "tb" ? Position.Top : Position.Left,
      data: {
        label: (
          <div className="topology-collection-label" title={collection.address}>
            <span className="topology-title-row topology-title-row--collection">
              <span className="topology-title-row">
                <strong>{collection.name}</strong>
                <span className="topology-unit-type">{shortType(collection.componentType)}</span>
              </span>
              <button
                type="button"
                data-open-collection="true"
                className="topology-collection-open-btn"
                title="Open collection scope"
                aria-label={`Open ${collection.name} scope`}
              >
                ↗ Open
              </button>
            </span>
            <span className="mono">{compactCollectionAddress(collection.address)}</span>
          </div>
        ),
      },
      style: {
        width: size.width,
        height: size.height,
        border: `2px dashed ${COLLECTION_BORDER[1]}`,
        borderRadius: 12,
        background: COLLECTION_BG[1],
        color: "#0f172a",
        padding: 10,
      },
    });

    const inputs = collection.streams.filter((stream) => stream.direction === "input");
    const outputs = collection.streams.filter((stream) => stream.direction === "output");
    const unknown = collection.streams.filter((stream) => stream.direction === "unknown");

    if (layoutMode === "lr") {
      const rowStep = 30;
      const maxRows = Math.max(1, inputs.length, outputs.length);
      const blockHeight = maxRows * rowStep;
      const headerHeight = COLLECTION_NODE_HEADER_HEIGHT;
      const availableRowsHeight = Math.max(0, size.height - headerHeight - 12);
      const top = headerHeight + Math.max(0, Math.floor((availableRowsHeight - blockHeight) / 2));

      inputs.forEach((stream, index) => {
        const visual = streamNodeVisualStyle(stream, "is-input", "collection");
        nodes.push({
          id: `stream:${stream.address}`,
          parentNode: nodeId,
          extent: "parent",
          draggable: false,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          data: {
            label: (
              <span className={streamLabelClassName(stream, "is-input", "collection")} title={stream.address}>
                <span className="topology-stream-name">
                  {truncate(streamDisplayName(stream.name, stream.address), 10)}
                </span>
                {compactMsgType(stream.msgType) ? (
                  <span className="topology-stream-type">[{compactMsgType(stream.msgType)}]</span>
                ) : null}
              </span>
            ),
          },
          position: { x: 10, y: top + index * rowStep },
          style: {
            width: STREAM_NODE_WIDTH,
            height: STREAM_NODE_HEIGHT,
            borderRadius: visual.borderRadius,
            border: visual.border,
            background: visual.background,
            color: visual.color,
            padding: "1px 6px",
          },
        });
      });

      outputs.forEach((stream, index) => {
        const visual = streamNodeVisualStyle(stream, "is-output", "collection");
        nodes.push({
          id: `stream:${stream.address}`,
          parentNode: nodeId,
          extent: "parent",
          draggable: false,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          data: {
            label: (
              <span className={streamLabelClassName(stream, "is-output", "collection")} title={stream.address}>
                <span className="topology-stream-name">
                  {truncate(streamDisplayName(stream.name, stream.address), 10)}
                </span>
                {compactMsgType(stream.msgType) ? (
                  <span className="topology-stream-type">[{compactMsgType(stream.msgType)}]</span>
                ) : null}
              </span>
            ),
          },
          position: { x: size.width - STREAM_NODE_WIDTH - 10, y: top + index * rowStep },
          style: {
            width: STREAM_NODE_WIDTH,
            height: STREAM_NODE_HEIGHT,
            borderRadius: visual.borderRadius,
            border: visual.border,
            background: visual.background,
            color: visual.color,
            padding: "1px 6px",
          },
        });
      });

      if (unknown.length > 0) {
        placeUnitStreamRow(
          nodeId,
          size,
          unknown,
          size.height - STREAM_NODE_HEIGHT - 10,
          "is-unknown",
          "collection",
          layoutMode,
          nodes
        );
      }
    } else {
      const topInputY = 86;
      const bottomOutputY = Math.max(
        topInputY + STREAM_NODE_HEIGHT + 10,
        size.height - STREAM_NODE_HEIGHT - 12
      );
      placeUnitStreamRow(nodeId, size, inputs, topInputY, "is-input", "collection", layoutMode, nodes);
      placeUnitStreamRow(
        nodeId,
        size,
        outputs,
        bottomOutputY,
        "is-output",
        "collection",
        layoutMode,
        nodes
      );
      if (unknown.length > 0) {
        placeUnitStreamRow(
          nodeId,
          size,
          unknown,
          Math.floor((size.height - STREAM_NODE_HEIGHT) / 2) + 14,
          "is-unknown",
          "collection",
          layoutMode,
          nodes
        );
      }
    }
  }

  function placeUnitStreamRow(
    unitOwnerId: string,
    size: { width: number; height: number },
    streams: UnitComponent["streams"],
    top: number,
    className: "is-input" | "is-output" | "is-unknown",
    ownerKind: "unit" | "collection",
    layout: LayoutMode,
    nodesOut: Node[]
  ): void {
    if (streams.length === 0) {
      return;
    }
    const available = size.width - 22;
    const totalWidth = streams.length * STREAM_NODE_WIDTH;
    const gap =
      streams.length > 1
        ? Math.max(6, Math.min(16, Math.floor((available - totalWidth) / (streams.length - 1))))
        : 0;
    const usedWidth = totalWidth + gap * Math.max(0, streams.length - 1);
    const startX = 11 + Math.max(0, Math.floor((available - usedWidth) / 2));

    streams.forEach((stream, index) => {
      const visual = streamNodeVisualStyle(stream, className, ownerKind);
      const left = startX + index * (STREAM_NODE_WIDTH + gap);
      nodesOut.push({
        id: `stream:${stream.address}`,
        parentNode: unitOwnerId,
        extent: "parent",
        draggable: false,
        data: {
          label: (
            <span className={streamLabelClassName(stream, className, ownerKind)} title={stream.address}>
              <span className="topology-stream-name">
                {truncate(streamDisplayName(stream.name, stream.address), 10)}
              </span>
              {compactMsgType(stream.msgType) ? (
                <span className="topology-stream-type">[{compactMsgType(stream.msgType)}]</span>
              ) : null}
            </span>
          ),
        },
        position: { x: left, y: top },
        sourcePosition: layout === "tb" ? Position.Bottom : Position.Right,
        targetPosition: layout === "tb" ? Position.Top : Position.Left,
        style: {
          width: STREAM_NODE_WIDTH,
          height: STREAM_NODE_HEIGHT,
          borderRadius: visual.borderRadius,
          border: visual.border,
          background: visual.background,
          color: visual.color,
          fontSize: 8,
          padding: "1px 6px",
        },
      });
    });
  }

  for (const unit of visibleUnits.values()) {
    const ownerId = `unit:${unit.address}`;
    const pos = ownerPosition.get(ownerId) ?? { x: 0, y: 0 };
    const size = ownerSizeById.get(ownerId) ?? { width: UNIT_WIDTH, height: MIN_UNIT_HEIGHT };
    const inputs = unit.streams.filter((stream) => stream.direction === "input");
    const outputs = unit.streams.filter((stream) => stream.direction === "output");
    const unknown = unit.streams.filter((stream) => stream.direction === "unknown");
    const localStreamAddresses = new Set(unit.streams.map((stream) => stream.address));
    const localStreamLookup = buildLocalStreamLookup(unit.streams);

    nodes.push({
      id: ownerId,
      position: pos,
      data: {
        label: (
          <div className="topology-unit-label">
            <span
              className="topology-title-row"
              title="Click to inspect settings"
            >
              <strong>{unit.name}</strong>
              <span className="topology-unit-type">{shortType(unit.componentType)}</span>
            </span>
            <span className="mono topology-unit-address" title={unit.address}>
              {truncate(compactCollectionAddress(unit.address), 34)}
            </span>
          </div>
        ),
      },
      style: {
        width: size.width,
        height: size.height,
        border: "1px solid #93c5fd",
        borderRadius: 12,
        background: "#f8fbff",
        padding: 10,
      },
    });

    if (layoutMode === "lr") {
      const taskHeight = 22;
      const taskWidth = 96;
      const rowStep = 30;
      const maxRows = Math.max(1, inputs.length, outputs.length, unit.tasks.length);
      const blockHeight = maxRows * rowStep;
      const bodyTop = UNIT_NODE_HEADER_HEIGHT;
      const bodyHeight = Math.max(0, size.height - bodyTop - 10);
      const top = bodyTop + Math.max(0, Math.floor((bodyHeight - blockHeight) / 2));

      inputs.forEach((stream, index) => {
        nodes.push({
          id: `stream:${stream.address}`,
          parentNode: ownerId,
          extent: "parent",
          draggable: false,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          data: {
            label: (
              <span className="mono topology-stream-label is-input" title={stream.address}>
                <span className="topology-stream-name">
                  {truncate(streamDisplayName(stream.name, stream.address), 10)}
                </span>
                {compactMsgType(stream.msgType) ? (
                  <span className="topology-stream-type">[{compactMsgType(stream.msgType)}]</span>
                ) : null}
              </span>
            ),
          },
          position: { x: 10, y: top + index * rowStep },
          style: {
            width: STREAM_NODE_WIDTH,
            height: STREAM_NODE_HEIGHT,
            borderRadius: 999,
            border: "1px solid #c7d2fe",
            background: "#eef2ff",
            padding: "1px 6px",
          },
        });
      });

      outputs.forEach((stream, index) => {
        nodes.push({
          id: `stream:${stream.address}`,
          parentNode: ownerId,
          extent: "parent",
          draggable: false,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          data: {
            label: (
              <span className="mono topology-stream-label is-output" title={stream.address}>
                <span className="topology-stream-name">
                  {truncate(streamDisplayName(stream.name, stream.address), 10)}
                </span>
                {compactMsgType(stream.msgType) ? (
                  <span className="topology-stream-type">[{compactMsgType(stream.msgType)}]</span>
                ) : null}
              </span>
            ),
          },
          position: { x: size.width - STREAM_NODE_WIDTH - 10, y: top + index * rowStep },
          style: {
            width: STREAM_NODE_WIDTH,
            height: STREAM_NODE_HEIGHT,
            borderRadius: 999,
            border: "1px solid #7dd3fc",
            background: "#ecfeff",
            padding: "1px 6px",
          },
        });
      });

      unit.tasks.forEach((task, index) => {
        const taskId = `task:${unit.address}:${task.name}`;
        const subscribedStream = resolveTaskStreamReference(task.subscribes, localStreamLookup);
        const publishedStreams = Array.from(
          new Set(
            task.publishes
              .map((streamRef) => resolveTaskStreamReference(streamRef, localStreamLookup))
              .filter((value): value is string => value !== null)
          )
        );
        nodes.push({
          id: taskId,
          parentNode: ownerId,
          extent: "parent",
          draggable: false,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          data: {
            label: (
              <span className="mono topology-task-label" title={task.name}>
                {truncate(task.name, 15)}
              </span>
            ),
          },
          position: { x: Math.floor((size.width - taskWidth) / 2), y: top + index * rowStep + 4 },
          style: {
            width: taskWidth,
            height: taskHeight,
            borderRadius: 999,
            border: "1px solid #dbe2ea",
            background: "#f1f5f9",
            padding: "1px 6px",
          },
        });

        if (subscribedStream && localStreamAddresses.has(subscribedStream)) {
          edges.push({
            id: `edge:internal:${unit.address}:${task.name}:sub`,
            source: `stream:${subscribedStream}`,
            target: taskId,
            type: connectorType,
            zIndex: 20,
            className: "topology-internal-edge",
            markerEnd: internalMarker,
            style: internalEdgeStyle,
          });
        }
        for (const publishedStream of publishedStreams) {
          if (!localStreamAddresses.has(publishedStream)) {
            continue;
          }
          edges.push({
            id: `edge:internal:${unit.address}:${task.name}:${publishedStream}`,
            source: taskId,
            target: `stream:${publishedStream}`,
            type: connectorType,
            zIndex: 20,
            className: "topology-internal-edge",
            markerEnd: internalMarker,
            style: internalEdgeStyle,
          });
        }
      });

      if (unknown.length > 0) {
        placeUnitStreamRow(
          ownerId,
          size,
          unknown,
          size.height - STREAM_NODE_HEIGHT - 8,
          "is-unknown",
          "unit",
          layoutMode,
          nodes
        );
      }
    } else {
      const taskWidth = 92;
      const taskHeight = 22;
      const topInputY = UNIT_NODE_HEADER_HEIGHT + 2;
      const bottomOutputY = size.height - STREAM_NODE_HEIGHT - 12;
      const taskBandTop = topInputY + STREAM_NODE_HEIGHT + 10;
      const taskBandBottom = bottomOutputY - 8;
      const taskY =
        taskBandTop
        + Math.max(0, Math.floor((taskBandBottom - taskBandTop - taskHeight) / 2));

      placeUnitStreamRow(ownerId, size, inputs, topInputY, "is-input", "unit", layoutMode, nodes);
      placeUnitStreamRow(
        ownerId,
        size,
        outputs,
        bottomOutputY,
        "is-output",
        "unit",
        layoutMode,
        nodes
      );
      if (unknown.length > 0) {
        placeUnitStreamRow(
          ownerId,
          size,
          unknown,
          taskY + 28,
          "is-unknown",
          "unit",
          layoutMode,
          nodes
        );
      }

      const taskCount = unit.tasks.length;
      const taskAvailable = size.width - 20;
      const totalTaskWidth = taskCount * taskWidth;
      const taskGap =
        taskCount > 1
          ? Math.max(10, Math.min(22, Math.floor((taskAvailable - totalTaskWidth) / (taskCount - 1))))
          : 0;
      const used = totalTaskWidth + taskGap * Math.max(0, taskCount - 1);
      const taskStart = 10 + Math.max(0, Math.floor((taskAvailable - used) / 2));

      unit.tasks.forEach((task, index) => {
        const taskId = `task:${unit.address}:${task.name}`;
        const subscribedStream = resolveTaskStreamReference(task.subscribes, localStreamLookup);
        const publishedStreams = Array.from(
          new Set(
            task.publishes
              .map((streamRef) => resolveTaskStreamReference(streamRef, localStreamLookup))
              .filter((value): value is string => value !== null)
          )
        );
        nodes.push({
          id: taskId,
          parentNode: ownerId,
          extent: "parent",
          draggable: false,
          sourcePosition: Position.Bottom,
          targetPosition: Position.Top,
          data: {
            label: (
              <span className="mono topology-task-label" title={task.name}>
                {truncate(task.name, 15)}
              </span>
            ),
          },
          position: { x: taskStart + index * (taskWidth + taskGap), y: taskY },
          style: {
            width: taskWidth,
            height: taskHeight,
            borderRadius: 999,
            border: "1px solid #dbe2ea",
            background: "#f1f5f9",
            padding: "1px 6px",
          },
        });

        if (subscribedStream && localStreamAddresses.has(subscribedStream)) {
          edges.push({
            id: `edge:internal:${unit.address}:tb:${task.name}:sub`,
            source: `stream:${subscribedStream}`,
            target: taskId,
            type: connectorType,
            zIndex: 20,
            className: "topology-internal-edge",
            markerEnd: internalMarker,
            style: internalEdgeStyle,
          });
        }
        for (const publishedStream of publishedStreams) {
          if (!localStreamAddresses.has(publishedStream)) {
            continue;
          }
          edges.push({
            id: `edge:internal:${unit.address}:tb:${task.name}:${publishedStream}`,
            source: taskId,
            target: `stream:${publishedStream}`,
            type: connectorType,
            zIndex: 20,
            className: "topology-internal-edge",
            markerEnd: internalMarker,
            style: internalEdgeStyle,
          });
        }
      });
    }
  }

  for (const streamAddress of relevantStreams) {
    const owner = streamOwnerByAddress.get(streamAddress);
    if (owner && owner.ownerKind !== "orphan") {
      continue;
    }
    const ownerId = `orphan:${streamAddress}`;
    const pos = ownerPosition.get(ownerId) ?? { x: 0, y: 0 };
    nodes.push({
      id: `stream:${streamAddress}`,
      position: pos,
      sourcePosition: layoutMode === "tb" ? Position.Bottom : Position.Right,
      targetPosition: layoutMode === "tb" ? Position.Top : Position.Left,
      data: {
        label: (
          <div className="mono topology-orphan-label">
            <strong>{friendlyAddressLabel(streamAddress)}</strong>
            <span>{truncate(streamAddress, 54)}</span>
          </div>
        ),
      },
      style: {
        width: ORPHAN_NODE_WIDTH,
        border: "1px solid #dbe2ea",
        borderRadius: 10,
        background: "#ffffff",
        padding: 6,
      },
    });
  }

  const nodeIdForStream = (streamAddress: string): string => {
    const owner = streamOwnerByAddress.get(streamAddress);
    if (!owner) {
      return `stream:${streamAddress}`;
    }
    if (
      owner.ownerKind === "unit"
      || owner.ownerKind === "collection"
      || owner.ownerKind === "scope_collection"
      || owner.ownerKind === "orphan"
    ) {
      return `stream:${streamAddress}`;
    }
    return owner.ownerId;
  };
  const ownerIdForStream = (streamAddress: string): string | null =>
    streamOwnerByAddress.get(streamAddress)?.ownerId ?? null;

  for (const edge of relevantRawEdges) {
    const sourceId = nodeIdForStream(edge.from);
    const targetId = nodeIdForStream(edge.to);
    if (sourceId === targetId) {
      continue;
    }
    const fromOwner = ownerIdForStream(edge.from);
    const toOwner = ownerIdForStream(edge.to);
    if (fromOwner && toOwner && fromOwner === toOwner && fromOwner.startsWith("scope:")) {
      continue;
    }
    if (fromOwner && toOwner && fromOwner === toOwner && fromOwner.startsWith("collection:")) {
      continue;
    }
    if (fromOwner && toOwner && fromOwner === toOwner && fromOwner.startsWith("unit:")) {
      const unit = visibleUnits.get(fromOwner.slice("unit:".length));
      if (unit && unit.tasks.length > 0) {
        continue;
      }
    }
    edges.push({
      id: `edge:${edge.from}->${edge.to}`,
      source: sourceId,
      target: targetId,
      type: connectorType,
      zIndex: 1,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 12,
        height: 12,
        color: "#64748b",
      },
      style: {
        stroke: "#64748b",
        strokeWidth: 1.2,
      },
    });
  }

  return { nodes, edges };
}

export function TopologyPanel({
  graphSnapshot,
  profilingSnapshot = null,
  recentEvents,
  immersive = false,
  showLegend = true,
  showMiniMap = true,
  defaultLayout = "tb",
  edgeConnectorStyle = "curved",
  autoFitOnLayoutScopeChange = true,
  autoFocusOnSelection = true,
  focusSelection = null,
  focusRequestId = 0,
  onEntitySelect,
}: TopologyPanelProps) {
  const flowShellRef = useRef<HTMLDivElement | null>(null);
  const flowInstanceRef = useRef<ReactFlowInstance | null>(null);
  const flowCacheByScopeRef = useRef<Map<string, FlowData>>(new Map());
  const lastActiveAliasesSignatureRef = useRef<string>("");
  const autoScopeSignatureRef = useRef<string | null>(null);
  const lastHandledFocusRequestRef = useRef<number>(0);
  const pendingScopeFocusRequestRef = useRef<number | null>(null);
  const scheduledFocusRequestRef = useRef<number | null>(null);
  const previousPublisherTotalsRef = useRef<Map<string, number>>(new Map());
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [flowInitTick, setFlowInitTick] = useState(0);
  const [scopeCollectionAddress, setScopeCollectionAddress] = useState<string | null>(null);
  const [activePublisherStreamAliases, setActivePublisherStreamAliases] = useState<string[]>([]);
  const layoutMode: LayoutMode = defaultLayout;

  useEffect(() => {
    if (!profilingSnapshot) {
      previousPublisherTotalsRef.current = new Map();
      setActivePublisherStreamAliases([]);
      return;
    }
    const previousTotals = previousPublisherTotalsRef.current;
    const nextTotals = new Map<string, number>();
    const activeAliases = new Set<string>();
    for (const process of Object.values(profilingSnapshot)) {
      const processId = process.process_id;
      for (const publisher of Object.values(process.publishers)) {
        const total =
          typeof publisher.messages_published_total === "number"
          && Number.isFinite(publisher.messages_published_total)
            ? publisher.messages_published_total
            : 0;
        const key = `${processId}:${publisher.endpoint_id}`;
        const previous = previousTotals.get(key);
        if (previous !== undefined && total > previous) {
          activeAliases.add(`${publisher.topic}:${publisher.endpoint_id}`);
        }
        nextTotals.set(key, total);
      }
    }
    previousPublisherTotalsRef.current = nextTotals;
    const nextAliases = Array.from(activeAliases).sort();
    const nextSignature = nextAliases.join("|");
    if (nextSignature === lastActiveAliasesSignatureRef.current) {
      return;
    }
    lastActiveAliasesSignatureRef.current = nextSignature;
    setActivePublisherStreamAliases(nextAliases);
  }, [profilingSnapshot]);
  const topologyComponents = useMemo(
    () => (graphSnapshot ? classifyComponents(graphSnapshot) : null),
    [graphSnapshot]
  );
  const parentCollectionByAddress = useMemo(
    () => (topologyComponents ? buildCollectionParentMap(topologyComponents.collections) : new Map<string, string>()),
    [topologyComponents]
  );
  const scopePath = useMemo(
    () => (topologyComponents ? collectionScopePath(topologyComponents.collections, scopeCollectionAddress) : []),
    [topologyComponents, scopeCollectionAddress]
  );
  const unitStreamByAddress = useMemo(() => {
    const streamByAddress = new Map<
      string,
      { direction: StreamDirection; unitAddress: string }
    >();
    if (!topologyComponents) {
      return streamByAddress;
    }
    for (const unit of topologyComponents.units.values()) {
      for (const stream of unit.streams) {
        streamByAddress.set(stream.address, {
          direction: stream.direction,
          unitAddress: unit.address,
        });
        streamByAddress.set(streamAddressWithoutEndpoint(stream.address), {
          direction: stream.direction,
          unitAddress: unit.address,
        });
      }
    }
    return streamByAddress;
  }, [topologyComponents]);
  const unitAddressByEndpointId = useMemo(() => {
    const index = new Map<string, string>();
    if (!topologyComponents) {
      return index;
    }
    for (const unit of topologyComponents.units.values()) {
      for (const stream of unit.streams) {
        const endpointId = stream.address.split(":").slice(1).join(":");
        if (endpointId.length > 0 && !index.has(endpointId)) {
          index.set(endpointId, unit.address);
        }
      }
    }
    return index;
  }, [topologyComponents]);
  const canonicalStreamByAlias = useMemo(() => {
    const canonicalByAlias = new Map<string, string>();
    if (!topologyComponents) {
      return canonicalByAlias;
    }
    for (const unit of topologyComponents.units.values()) {
      for (const stream of unit.streams) {
        canonicalByAlias.set(stream.address, stream.address);
        canonicalByAlias.set(streamAddressWithoutEndpoint(stream.address), stream.address);
      }
    }
    for (const collection of topologyComponents.collections.values()) {
      for (const stream of collection.streams) {
        canonicalByAlias.set(stream.address, stream.address);
        canonicalByAlias.set(streamAddressWithoutEndpoint(stream.address), stream.address);
      }
    }
    return canonicalByAlias;
  }, [topologyComponents]);
  const activeCanonicalSourceStreams = useMemo(() => {
    if (!topologyComponents) {
      return new Set<string>();
    }
    const active = new Set<string>();
    for (const alias of activePublisherStreamAliases) {
      const canonical =
        canonicalStreamByAlias.get(alias)
        ?? canonicalStreamByAlias.get(streamAddressWithoutEndpoint(alias))
        ?? null;
      if (!canonical) {
        continue;
      }
      active.add(canonical);
      active.add(streamAddressWithoutEndpoint(canonical));
    }
    return active;
  }, [activePublisherStreamAliases, canonicalStreamByAlias, topologyComponents]);
  const activeReachableSourceStreams = useMemo(() => {
    if (!graphSnapshot || activeCanonicalSourceStreams.size === 0) {
      return activeCanonicalSourceStreams;
    }
    const adjacency = new Map<string, string[]>();
    for (const [fromRaw, toList] of Object.entries(graphSnapshot.graph)) {
      const fromCanonical =
        canonicalStreamByAlias.get(fromRaw)
        ?? canonicalStreamByAlias.get(streamAddressWithoutEndpoint(fromRaw))
        ?? fromRaw;
      const row = adjacency.get(fromCanonical) ?? [];
      for (const toRaw of toList) {
        const toCanonical =
          canonicalStreamByAlias.get(toRaw)
          ?? canonicalStreamByAlias.get(streamAddressWithoutEndpoint(toRaw))
          ?? toRaw;
        row.push(toCanonical);
      }
      adjacency.set(fromCanonical, row);
    }

    const visited = new Set<string>();
    const queue = Array.from(activeCanonicalSourceStreams);
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) {
        continue;
      }
      visited.add(current);
      const downstream = adjacency.get(current) ?? [];
      for (const next of downstream) {
        if (!visited.has(next)) {
          queue.push(next);
        }
      }
    }

    const expanded = new Set<string>();
    for (const stream of visited) {
      expanded.add(stream);
      expanded.add(streamAddressWithoutEndpoint(stream));
    }
    return expanded;
  }, [activeCanonicalSourceStreams, canonicalStreamByAlias, graphSnapshot]);
  const activeScope = scopePath.length > 0 ? scopePath[scopePath.length - 1] : null;
  const flowScopeKey = `${layoutMode}:${activeScope ?? "root"}`;
  const computedFlowData = useMemo(
    () =>
      graphSnapshot
        ? buildFlowData(
            graphSnapshot,
            layoutMode,
            activeScope,
            edgeConnectorStyle
          )
        : { nodes: [], edges: [] },
    [graphSnapshot, layoutMode, activeScope, edgeConnectorStyle]
  );
  const flowData = useMemo(() => {
    if (computedFlowData.nodes.length > 0 && validateFlowData(computedFlowData)) {
      flowCacheByScopeRef.current.set(flowScopeKey, computedFlowData);
      return computedFlowData;
    }

    const cached = flowCacheByScopeRef.current.get(flowScopeKey);
    if (cached && cached.nodes.length > 0) {
      return cached;
    }
    return computedFlowData;
  }, [computedFlowData, flowScopeKey]);
  const renderedFlowData = useMemo((): FlowData => {
    if (activeReachableSourceStreams.size === 0 || flowData.edges.length === 0) {
      return flowData;
    }

    const isStreamActive = (streamAddress: string | null): boolean => {
      if (!streamAddress) {
        return false;
      }
      const normalized = streamAddressWithoutEndpoint(streamAddress);
      return (
        activeReachableSourceStreams.has(streamAddress)
        || activeReachableSourceStreams.has(normalized)
      );
    };

    const outgoingEdgeIndexesByNode = new Map<string, number[]>();
    flowData.edges.forEach((edge, index) => {
      const existing = outgoingEdgeIndexesByNode.get(edge.source);
      if (existing) {
        existing.push(index);
      } else {
        outgoingEdgeIndexesByNode.set(edge.source, [index]);
      }
    });

    const activeEdgeIndexes = new Set<number>();
    const activeNodeIds = new Set<string>();
    const queue: string[] = [];
    const enqueueNode = (nodeId: string) => {
      if (activeNodeIds.has(nodeId)) {
        return;
      }
      activeNodeIds.add(nodeId);
      queue.push(nodeId);
    };

    flowData.edges.forEach((edge, index) => {
      const sourceFromNode = edge.source.startsWith("stream:")
        ? edge.source.slice("stream:".length)
        : null;
      const sourceFromEdgeId = sourceStreamAddressFromEdgeId(edge.id);
      if (!isStreamActive(sourceFromNode ?? sourceFromEdgeId)) {
        return;
      }
      activeEdgeIndexes.add(index);
      enqueueNode(edge.target);
    });

    while (queue.length > 0) {
      const nodeId = queue.shift();
      if (!nodeId) {
        continue;
      }
      const outgoing = outgoingEdgeIndexesByNode.get(nodeId);
      if (!outgoing || outgoing.length === 0) {
        continue;
      }
      for (const edgeIndex of outgoing) {
        if (activeEdgeIndexes.has(edgeIndex)) {
          continue;
        }
        activeEdgeIndexes.add(edgeIndex);
        enqueueNode(flowData.edges[edgeIndex].target);
      }
    }

    if (activeEdgeIndexes.size === 0) {
      return flowData;
    }

    const edges = flowData.edges.map((edge, index) => {
      if (!activeEdgeIndexes.has(index)) {
        return edge;
      }
      const markerEnd =
        typeof edge.markerEnd === "object" && edge.markerEnd !== null
          ? { ...edge.markerEnd, color: "#2563eb" }
          : {
              type: MarkerType.ArrowClosed,
              width: 12,
              height: 12,
              color: "#2563eb",
            };
      return {
        ...edge,
        animated: true,
        markerEnd,
        style: {
          ...(edge.style ?? {}),
          stroke: "#2563eb",
          strokeWidth: 1.7,
        },
      };
    });
    return {
      nodes: flowData.nodes,
      edges,
    };
  }, [activeReachableSourceStreams, flowData]);
  const openCollectionScope = (nodeId: string) => {
    if (!nodeId.startsWith("collection:")) {
      return;
    }
    const collectionAddress = nodeId.slice("collection:".length);
    if (!topologyComponents?.collections.has(collectionAddress)) {
      return;
    }
    setScopeCollectionAddress(collectionAddress);
  };
  const selectEntityForNode = (nodeId: string) => {
    if (nodeId.startsWith("unit:")) {
      onEntitySelect?.({
        kind: "unit",
        unitAddress: nodeId.slice("unit:".length),
      });
      return;
    }
    if (nodeId.startsWith("collection:")) {
      onEntitySelect?.({
        kind: "collection",
        collectionAddress: nodeId.slice("collection:".length),
      });
      return;
    }
    if (nodeId.startsWith("stream:")) {
      const streamAddress = nodeId.slice("stream:".length);
      const meta =
        unitStreamByAddress.get(streamAddress)
        ?? unitStreamByAddress.get(streamAddressWithoutEndpoint(streamAddress));
      if (!meta) {
        onEntitySelect?.(null);
        return;
      }
      if (meta.direction === "output") {
        onEntitySelect?.({
          kind: "publisher",
          streamAddress,
          unitAddress: meta.unitAddress,
        });
        return;
      }
      if (meta.direction === "input") {
        onEntitySelect?.({
          kind: "subscriber",
          streamAddress,
          unitAddress: meta.unitAddress,
        });
        return;
      }
    }
    onEntitySelect?.(null);
  };
  useEffect(() => {
    if (!topologyComponents || !scopeCollectionAddress) {
      return;
    }
    if (!topologyComponents.collections.has(scopeCollectionAddress)) {
      setScopeCollectionAddress(null);
    }
  }, [scopeCollectionAddress, topologyComponents]);
  useEffect(() => {
    if (!topologyComponents) {
      autoScopeSignatureRef.current = null;
      return;
    }
    const rootAddresses = visibleComponentAddresses(
      topologyComponents.units,
      topologyComponents.collections,
      null
    );
    const onlyAddress = rootAddresses.length === 1 ? rootAddresses[0] : null;
    const canAutoEnter =
      onlyAddress !== null
      && topologyComponents.collections.has(onlyAddress)
      && collectionHasVisibleChildren(
        onlyAddress,
        topologyComponents.units,
        topologyComponents.collections
      );
    const signature = `${rootAddresses.slice().sort().join("|")}::${canAutoEnter ? "ready" : "wait"}`;
    if (autoScopeSignatureRef.current === signature) {
      return;
    }
    autoScopeSignatureRef.current = signature;
    if (scopeCollectionAddress !== null) {
      return;
    }
    if (!canAutoEnter || !onlyAddress) {
      return;
    }
    setScopeCollectionAddress(onlyAddress);
  }, [scopeCollectionAddress, topologyComponents]);

  useEffect(() => {
    if (!topologyComponents || !scopeCollectionAddress) {
      return;
    }
    const scopedVisible = visibleComponentAddresses(
      topologyComponents.units,
      topologyComponents.collections,
      scopeCollectionAddress
    );
    if (scopedVisible.length === 0) {
      setScopeCollectionAddress(null);
    }
  }, [scopeCollectionAddress, topologyComponents]);

  useEffect(() => {
    if (!autoFocusOnSelection || !focusSelection || focusRequestId <= 0) {
      return;
    }
    if (lastHandledFocusRequestRef.current === focusRequestId) {
      return;
    }
    const instance = flowInstanceRef.current;
    if (!instance) {
      return;
    }

    const streamEndpointId = focusSelection.kind === "publisher" || focusSelection.kind === "subscriber"
      ? focusSelection.streamAddress.split(":").slice(1).join(":")
      : "";
    const inferredUnitAddress =
      focusSelection.kind === "publisher" || focusSelection.kind === "subscriber"
        ? (focusSelection.unitAddress ?? unitAddressByEndpointId.get(streamEndpointId) ?? null)
        : null;
    const selectedAddress =
      focusSelection.kind === "unit"
        ? focusSelection.unitAddress
        : focusSelection.kind === "collection"
          ? focusSelection.collectionAddress
          : inferredUnitAddress;
    if (selectedAddress && topologyComponents) {
      const desiredScope = parentCollectionByAddress.get(selectedAddress) ?? null;
      if (desiredScope !== activeScope) {
        pendingScopeFocusRequestRef.current = focusRequestId;
        setScopeCollectionAddress(desiredScope);
        return;
      }
    }

    let nodeId: string | null = null;
    if (focusSelection.kind === "unit") {
      nodeId = `unit:${focusSelection.unitAddress}`;
    } else if (focusSelection.kind === "collection") {
      nodeId = `collection:${focusSelection.collectionAddress}`;
    } else if (focusSelection.kind === "publisher" || focusSelection.kind === "subscriber") {
      const unitAddress = inferredUnitAddress;
      if (unitAddress) {
        nodeId = `unit:${unitAddress}`;
      } else {
        const streamAddress = focusSelection.streamAddress;
        if (streamAddress) {
          const endpointId = streamAddress.split(":").slice(1).join(":");
          const topic = streamAddress.split(":")[0] ?? "";
          const matchedStreamNode = flowData.nodes.find((node) => {
            if (!node.id.startsWith("stream:")) {
              return false;
            }
            const address = node.id.slice("stream:".length);
            return address.includes(endpointId) || address.startsWith(topic);
          });
          nodeId = matchedStreamNode?.id ?? null;
        }
      }
    }
    if (!nodeId) {
      return;
    }
    if (!flowData.nodes.some((node) => node.id === nodeId)) {
      return;
    }
    const runFocus = () => {
      const latestInstance = flowInstanceRef.current;
      if (!latestInstance) {
        scheduledFocusRequestRef.current = null;
        return;
      }
      latestInstance.fitView({
        nodes: [{ id: nodeId }],
        padding: 0.36,
        duration: 240,
        minZoom: 0.35,
        maxZoom: 1.8,
      });
      lastHandledFocusRequestRef.current = focusRequestId;
      pendingScopeFocusRequestRef.current = null;
      scheduledFocusRequestRef.current = null;
    };

    const shouldDefer = pendingScopeFocusRequestRef.current === focusRequestId;
    if (shouldDefer) {
      if (scheduledFocusRequestRef.current === focusRequestId) {
        return;
      }
      scheduledFocusRequestRef.current = focusRequestId;
      requestAnimationFrame(() => {
        requestAnimationFrame(runFocus);
      });
      return;
    }

    runFocus();
  }, [
    activeScope,
    autoFocusOnSelection,
    focusRequestId,
    focusSelection,
    flowInitTick,
    flowData.nodes,
    layoutMode,
    parentCollectionByAddress,
    topologyComponents,
    unitAddressByEndpointId,
  ]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const host =
        (flowShellRef.current?.closest(".dashboard-layout") as HTMLElement | null)
        ?? flowShellRef.current;
      const fullscreenElement = document.fullscreenElement;
      if (!host || !fullscreenElement) {
        setIsFullscreen(false);
        return;
      }
      setIsFullscreen(
        fullscreenElement === host || fullscreenElement.contains(host)
      );
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  if (!graphSnapshot) {
    if (immersive) {
      return (
        <section className="topology-immersive">
          <div className="topology-empty-state">
            <p>Waiting for initial snapshot...</p>
          </div>
        </section>
      );
    }
    return (
      <Panel
        title="Topology"
        subtitle="Live graph, process ownership, and edge changes"
      >
        <div className="placeholder">
          <p>Waiting for initial snapshot...</p>
        </div>
      </Panel>
    );
  }

  const topicCount = Object.keys(graphSnapshot.graph).length;
  const edgeCount = graphEdgeCount(graphSnapshot.graph);
  const sessionCount = Object.keys(graphSnapshot.sessions).length;
  const processRows = Object.values(graphSnapshot.processes);
  const fullscreenHost =
    (flowShellRef.current?.closest(".dashboard-layout") as HTMLElement | null)
    ?? flowShellRef.current
    ?? document.documentElement;
  const toggleFullscreen = async () => {
    if (!fullscreenHost) {
      return;
    }
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await fullscreenHost.requestFullscreen();
      }
    } catch {
      // Ignore unsupported/fullscreen errors.
    }
  };
  const toolbarContent = (
    <div className="topology-flow-toolbar">
        <span className="topology-flow-toolbar__label">Scope</span>
        <button
          type="button"
          className={`topology-layout-btn ${activeScope ? "" : "is-active"}`}
          onClick={() => setScopeCollectionAddress(null)}
        >
          Root
        </button>
        <button
          type="button"
          className="topology-layout-btn"
          disabled={!activeScope}
          onClick={() => {
            if (!activeScope) {
              return;
            }
            setScopeCollectionAddress(parentCollectionByAddress.get(activeScope) ?? null);
          }}
        >
          Up
        </button>
        {scopePath.length > 0 ? (
          <span className="topology-scope-sep">|</span>
        ) : null}
        {scopePath.length > 0 ? (
          <span className="topology-scope-trail">
            {scopePath.map((collectionAddress, index) => {
              const label =
                topologyComponents?.collections.get(collectionAddress)?.name
                ?? compactCollectionAddress(collectionAddress);
              const isLast = index === scopePath.length - 1;
              return (
                <span key={`scope-${collectionAddress}`} className="topology-scope-segment">
                  {isLast ? (
                    <span className="topology-scope-tail">{label}</span>
                  ) : (
                    <button
                      type="button"
                      className="topology-scope-chip"
                      onClick={() => setScopeCollectionAddress(collectionAddress)}
                    >
                      {label}
                    </button>
                  )}
                  {isLast ? null : <span className="topology-scope-slash">/</span>}
                </span>
              );
            })}
          </span>
        ) : null}
      </div>
  );
  const legendContent = (
    <div className="topology-viewport-legend" aria-label="Topology legend">
      <span className="topology-viewport-legend__title">Legend</span>
      <span className="topology-viewport-legend__item">
        <i className="topology-viewport-legend__swatch is-collection" />
        Collection
      </span>
      <span className="topology-viewport-legend__item">
        <i className="topology-viewport-legend__swatch is-input" />
        Subscriber
      </span>
      <span className="topology-viewport-legend__item">
        <i className="topology-viewport-legend__swatch is-output" />
        Publisher
      </span>
      <span className="topology-viewport-legend__item">
        <i className="topology-viewport-legend__swatch is-topic" />
        Collection Topic
      </span>
      <span className="topology-viewport-legend__item">
        <i className="topology-viewport-legend__swatch is-relay" />
        Collection Relay
      </span>
      <span className="topology-viewport-legend__item">
        <i className="topology-viewport-legend__swatch is-task" />
        Task
      </span>
    </div>
  );

  const topologyViewport = (
    <>
      {immersive ? null : toolbarContent}

      <div className={`topology-flow-shell ${immersive ? "is-immersive" : ""}`} ref={flowShellRef}>
        {immersive ? (
          <div className="topology-viewport-top-controls">{toolbarContent}</div>
        ) : null}
        {immersive && showLegend ? (
          <div className="topology-viewport-bottom-dock">{legendContent}</div>
        ) : null}
        {immersive || !showLegend ? null : legendContent}
        <ReactFlow
          key={
            autoFitOnLayoutScopeChange
              ? `topology-flow-${layoutMode}-${activeScope ?? "root"}`
              : "topology-flow-stable"
          }
          nodes={renderedFlowData.nodes}
          edges={renderedFlowData.edges}
          fitView
          fitViewOptions={{ padding: 0.18, minZoom: 0.4 }}
          minZoom={0.2}
          maxZoom={2.4}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          onInit={(instance) => {
            flowInstanceRef.current = instance;
            setFlowInitTick((previous) => previous + 1);
          }}
          onPaneClick={() => onEntitySelect?.(null)}
          onNodeClick={(event, node) => {
            if (node.id.startsWith("collection:")) {
              const target = event.target as HTMLElement | null;
              if (target?.closest('[data-open-collection="true"]')) {
                openCollectionScope(node.id);
                return;
              }
              onEntitySelect?.({
                kind: "collection",
                collectionAddress: node.id.slice("collection:".length),
              });
              return;
            }
            selectEntityForNode(node.id);
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#d5deea" gap={24} />
          {showMiniMap ? (
            <MiniMap
              pannable
              zoomable
              nodeColor={(node) => {
                if (node.id.startsWith("collection:")) {
                  return "#dbeafe";
                }
                if (node.id.startsWith("unit:")) {
                  return "#bfdbfe";
                }
                return "#cbd5e1";
              }}
            />
          ) : null}
          <Controls showFitView={false} showInteractive={false}>
            <ControlButton
              className="topology-control-btn"
              title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              onClick={() => {
                void toggleFullscreen();
              }}
            >
              ⛶
            </ControlButton>
          </Controls>
        </ReactFlow>
      </div>
    </>
  );

  if (immersive) {
    return <section className="topology-immersive">{topologyViewport}</section>;
  }

  return (
    <Panel
      title="Topology"
      subtitle="Low-level publisher/subscriber wiring with optional metadata overlays"
    >
      <div className="stats-grid">
        <article className="stat-card">
          <span>Topics</span>
          <strong>{topicCount}</strong>
        </article>
        <article className="stat-card">
          <span>Edges</span>
          <strong>{edgeCount}</strong>
        </article>
        <article className="stat-card">
          <span>Sessions</span>
          <strong>{sessionCount}</strong>
        </article>
        <article className="stat-card">
          <span>Processes</span>
          <strong>{processRows.length}</strong>
        </article>
      </div>
      {topologyViewport}

      <div className="panel-section">
        <h3>Process Ownership</h3>
        {processRows.length === 0 ? (
          <p className="muted">No process ownership in current snapshot.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Process ID</th>
                <th>PID</th>
                <th>Host</th>
                <th>Units</th>
              </tr>
            </thead>
            <tbody>
              {processRows.map((process) => (
                <tr key={process.process_id}>
                  <td className="mono">{process.process_id.slice(0, 8)}</td>
                  <td>{process.pid ?? "-"}</td>
                  <td>{process.host ?? "-"}</td>
                  <td>{process.units.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel-section">
        <h3>Recent Topology Changes</h3>
        {recentEvents.length === 0 ? (
          <p className="muted">No topology events received yet.</p>
        ) : (
          <ul className="event-list">
            {recentEvents.slice(0, 8).map((event) => (
              <li key={`topo-${event.data.seq}`} className="event-item">
                <span className="event-pill">{event.data.event_type}</span>
                <span className="mono">seq {event.data.seq}</span>
                <span>
                  {event.data.changed_topics.length > 0
                    ? event.data.changed_topics.join(", ")
                    : "No topic list"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
