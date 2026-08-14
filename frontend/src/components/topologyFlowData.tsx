import { MarkerType, Position, type Edge, type Node } from "reactflow";

import {
  belongsToCollection,
  buildRelayAliasIndex,
  buildCollectionParentMap,
  classifyComponents,
  computeRanks,
  visibleComponentAddresses,
  type CollectionComponent,
  type UnitComponent,
} from "./topologyGraph";
import {
  COLLECTION_BG,
  COLLECTION_BORDER,
  COLLECTION_NODE_HEIGHT,
  COLLECTION_NODE_HEADER_HEIGHT,
  COLLECTION_NODE_WIDTH,
  COLLECTION_SCOPE_BOTTOM_PADDING,
  MIN_UNIT_HEIGHT,
  ORPHAN_NODE_WIDTH,
  OWNER_X_GAP,
  OWNER_Y_GAP,
  RANK_X_GAP,
  RANK_Y_GAP,
  requiredRowWidth,
  STREAM_NODE_HEIGHT,
  STREAM_NODE_WIDTH,
  STREAM_ROW_GAP,
  TASK_NODE_HEIGHT,
  TASK_NODE_WIDTH,
  TASK_ROW_GAP,
  TASK_ROW_HORIZONTAL_PADDING,
  UNIT_LR_MIN_WIDTH,
  UNIT_NODE_HEADER_HEIGHT,
  UNIT_WIDTH,
  estimateCollectionHeaderMinWidth,
  estimateUnitHeaderMinWidth,
} from "./topologyLayout";
import type { GraphSnapshotPayload } from "../types/api";
import { streamAddressWithoutEndpoint } from "../utils/streamAddress";

export type LayoutMode = "tb" | "lr";
export type FlowData = { nodes: Node[]; edges: Edge[] };
type TopologyButtonActions = {
  openCollectionScope?: (collectionAddress: string) => void;
  goUpFromScope?: (collectionAddress: string) => void;
};

/** Which node a stream address is drawn inside of. */
type StreamOwnerKind =
  | "unit"
  | "collection"
  | "scope_collection"
  | "scope_collection_stream"
  | "collection_proxy"
  | "orphan";

type StreamOwner = {
  ownerId: string;
  ownerKind: StreamOwnerKind;
};

function truncate(text: string, max = 40): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function friendlyAddressLabel(address: string): string {
  const baseAddress = streamAddressWithoutEndpoint(address);
  const pieces = baseAddress.split("/");
  if (pieces.length <= 3) {
    return baseAddress;
  }
  return `${pieces[pieces.length - 2]}/${pieces[pieces.length - 1]}`;
}

function shortType(componentType: string): string {
  const parts = componentType.split(".");
  return parts[parts.length - 1] || componentType;
}

function streamDisplayName(name: string, address: string): string {
  const compact = name.trim().length > 0 ? name.trim() : friendlyAddressLabel(address);
  const parts = compact.split("/");
  return parts.length > 0 ? parts[parts.length - 1] ?? compact : compact;
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

function isNeutralCollectionStream(stream: UnitComponent["streams"][number]): boolean {
  return stream.collectionKind !== null && stream.direction === "unknown";
}

function scopedNeutralStreamOwnerId(streamAddress: string): string {
  return `stream:${streamAddress}`;
}

function laneCount(...groups: Array<{ length: number }>): number {
  return Math.max(
    1,
    groups.reduce((count, group) => count + (group.length > 0 ? 1 : 0), 0)
  );
}

export function compactCollectionAddress(address: string): string {
  const parts = address.split("/");
  if (parts.length <= 2) {
    return address;
  }
  return parts.slice(Math.max(0, parts.length - 3)).join("/");
}

function componentTooltip(name: string, address: string, componentType: string): string {
  return [name, address, componentType].join("\n");
}

function streamTooltip(
  stream: UnitComponent["streams"][number],
  ownerKind: "unit" | "collection"
): string {
  const parts = [stream.address];
  if (stream.msgType) {
    parts.push(`Message Type: ${stream.msgType}`);
  }
  if (ownerKind === "collection" && stream.collectionKind === "topic") {
    parts.push("Collection Topic");
  }
  if (ownerKind === "collection" && stream.collectionKind === "relay") {
    parts.push("Collection Relay");
  }
  return parts.join("\n");
}

function streamLabelClassName(
  stream: UnitComponent["streams"][number],
  className: "is-input" | "is-output" | "is-unknown",
  ownerKind: "unit" | "collection"
): string {
  if (ownerKind === "collection" && stream.collectionKind) {
    if (className === "is-unknown") {
      return "mono topology-stream-label is-collection";
    }
    return "mono topology-stream-label is-collection";
  }
  return `mono topology-stream-label ${className}`;
}

function streamNodeVisualStyle(
  stream: UnitComponent["streams"][number],
  className: "is-input" | "is-output" | "is-unknown",
  ownerKind: "unit" | "collection",
  darkMode: boolean
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
          border: darkMode ? "1px solid #fb923c" : "1px solid #f28e2b",
          background: darkMode ? "#2e1f10" : "#fff1dd",
          color: darkMode ? "#fed7aa" : "#8a4f10",
          borderRadius: 999,
        };
      }
      if (className === "is-input") {
        return {
          border: darkMode ? "1px solid #f59e0b" : "1px solid #f6a44d",
          background: darkMode ? "#2a2115" : "#fff8ef",
          color: darkMode ? "#fdba74" : "#8a4f10",
          borderRadius: 999,
        };
      }
      return {
        border: darkMode ? "1px solid #fb923c" : "1px solid #f8b66f",
        background: darkMode ? "#2a2115" : "#fff8ef",
        color: darkMode ? "#fdba74" : "#8a4f10",
        borderRadius: 999,
      };
    }
    if (className === "is-output") {
      return {
        border: darkMode ? "1px solid #d8b4fe" : "1px solid #b07aa1",
        background: darkMode ? "#2a1d3a" : "#f8eef5",
        color: darkMode ? "#e9d5ff" : "#6f3f66",
        borderRadius: 999,
      };
    }
    if (className === "is-input") {
      return {
        border: darkMode ? "1px solid #c084fc" : "1px solid #c194b7",
        background: darkMode ? "#251b33" : "#fbf3f8",
        color: darkMode ? "#e9d5ff" : "#6f3f66",
        borderRadius: 999,
      };
    }
    return {
      border: darkMode ? "1px solid #d8b4fe" : "1px solid #b07aa1",
      background: darkMode ? "#2a1d3a" : "#f8eef5",
      color: darkMode ? "#e9d5ff" : "#6f3f66",
      borderRadius: 999,
    };
  }

  return {
    border:
      className === "is-input"
        ? darkMode ? "1px solid #818cf8" : "1px solid #c7d2fe"
        : className === "is-output"
          ? darkMode ? "1px solid #22d3ee" : "1px solid #7dd3fc"
          : darkMode ? "1px solid #4b5563" : "1px solid #cbd5e1",
    background:
      className === "is-input"
        ? darkMode ? "#1d2644" : "#eef2ff"
        : className === "is-output"
          ? darkMode ? "#0f2e37" : "#ecfeff"
          : darkMode ? "#182235" : "#f8fafc",
    color: darkMode ? "#dbeafe" : "#1e293b",
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

function chooseScopedUnknownRowY(
  scopedOwnerIds: string[],
  ownerPosition: Map<string, { x: number; y: number }>,
  ownerSizeById: Map<string, { width: number; height: number }>,
  scopePosY: number,
  scopeHeaderHeight: number,
  scopeContentHeight: number,
  scopeSizeHeight: number
): number {
  const minTop = scopeHeaderHeight + 8;
  const contentBottom = scopeHeaderHeight + scopeContentHeight;
  const maxTop = Math.max(minTop, Math.min(scopeSizeHeight - STREAM_NODE_HEIGHT - 10, contentBottom - STREAM_NODE_HEIGHT - 8));
  const fallbackTop = Math.max(minTop, Math.min(maxTop, Math.floor((scopeSizeHeight - STREAM_NODE_HEIGHT) / 2)));

  const ownerBands = scopedOwnerIds
    .map((ownerId) => {
      const position = ownerPosition.get(ownerId);
      const size = ownerSizeById.get(ownerId);
      if (!position || !size) {
        return null;
      }
      const top = position.y - scopePosY;
      return {
        top,
        bottom: top + size.height,
      };
    })
    .filter((band): band is { top: number; bottom: number } => band !== null)
    .sort((left, right) => left.top - right.top);

  if (ownerBands.length === 0) {
    return fallbackTop;
  }

  let bestTop = fallbackTop;
  let bestGap = -1;
  let previousBottom = minTop;

  for (const band of ownerBands) {
    const gap = band.top - previousBottom;
    if (gap >= STREAM_NODE_HEIGHT + 8 && gap > bestGap) {
      bestGap = gap;
      bestTop = previousBottom + Math.floor((gap - STREAM_NODE_HEIGHT) / 2);
    }
    previousBottom = Math.max(previousBottom, band.bottom);
  }

  const trailingGap = contentBottom - previousBottom;
  if (trailingGap >= STREAM_NODE_HEIGHT + 8 && trailingGap > bestGap) {
    bestTop = previousBottom + Math.floor((trailingGap - STREAM_NODE_HEIGHT) / 2);
  }

  return Math.max(minTop, Math.min(maxTop, bestTop));
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

export function validateFlowData(flow: FlowData): boolean {
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

export function buildFlowData(
  graphSnapshot: GraphSnapshotPayload,
  layoutMode: LayoutMode,
  scopeCollectionAddress: string | null,
  edgeConnectorStyle: "curved" | "orthogonal" | "smooth",
  darkMode: boolean,
  buttonActions?: TopologyButtonActions
): FlowData {
  const connectorType =
    edgeConnectorStyle === "orthogonal"
      ? "step"
      : edgeConnectorStyle === "smooth"
        ? "smoothstep"
        : "default";
  const { units, collections } = classifyComponents(graphSnapshot);
  const relayAliasIndex = buildRelayAliasIndex(collections);
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
  const scopedNeutralStreams = scopedCollection
    ? scopedCollection.streams.filter(isNeutralCollectionStream)
    : [];
  const scopedNeutralStreamByOwnerId = new Map(
    scopedNeutralStreams.map((stream) => [scopedNeutralStreamOwnerId(stream.address), stream] as const)
  );

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
  for (const [internalTopic, collectionAddress] of relayAliasIndex.collectionByInternalTopic.entries()) {
    collectionOwnerByStreamAddress.set(internalTopic, collectionAddress);
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
  for (const [internalTopic, endpointAddress] of relayAliasIndex.endpointByInternalTopic.entries()) {
    canonicalStreamByAlias.set(internalTopic, endpointAddress);
  }

  const canonicalizeStreamAddress = (streamAddress: string): string =>
    canonicalStreamByAlias.get(streamAddress)
    ?? canonicalStreamByAlias.get(streamAddressWithoutEndpoint(streamAddress))
    ?? streamAddress;

  const rawEdges: Array<{ from: string; to: string }> = [];
  for (const [fromTopic, toTopics] of Object.entries(graphSnapshot.graph)) {
    for (const toTopic of toTopics) {
      const from = canonicalizeStreamAddress(fromTopic);
      const to = canonicalizeStreamAddress(toTopic);
      if (from === to) {
        continue;
      }
      rawEdges.push({
        from,
        to,
      });
    }
  }

  const streamOwnerByAddress = new Map<string, StreamOwner>();
  const registerStreamOwner = (streamAddress: string, owner: StreamOwner) => {
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
  for (const stream of scopedNeutralStreams) {
    registerStreamOwner(stream.address, {
      ownerId: scopedNeutralStreamOwnerId(stream.address),
      ownerKind: "scope_collection_stream",
    });
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
  for (const stream of scopedNeutralStreams) {
    const ownerId = scopedNeutralStreamOwnerId(stream.address);
    ownerIds.add(ownerId);
    ownerLabel.set(ownerId, streamDisplayName(stream.name, stream.address));
  }
  for (const streamAddress of relevantStreams) {
    if (streamOwnerByAddress.has(streamAddress)) {
      continue;
    }
    const directCollectionOwner = collectionOwnerByStreamAddress.get(streamAddress);
    const directUnitOwner = unitOwnerByStreamAddress.get(streamAddress);
    if (directCollectionOwner && visibleCollectionAddresses.has(directCollectionOwner)) {
      registerStreamOwner(streamAddress, {
        ownerId: `collection:${directCollectionOwner}`,
        ownerKind: "collection",
      });
      continue;
    }
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
    const unknown = unit.streams.filter((stream) => stream.direction === "unknown").length;
    const tasks = unit.tasks.length;
    const maxRows = Math.max(1, inputs, outputs, tasks, unknown);
    const headerMinWidth = estimateUnitHeaderMinWidth(
      unit.name,
      unit.componentType,
      shortType
    );
    const streamRowMinWidth = requiredRowWidth(
      maxRows,
      STREAM_NODE_WIDTH,
      STREAM_ROW_GAP,
      22
    );
    const taskRowMinWidthTb = requiredRowWidth(
      tasks,
      TASK_NODE_WIDTH,
      TASK_ROW_GAP,
      TASK_ROW_HORIZONTAL_PADDING
    );
    const width =
      layoutMode === "lr"
        ? Math.max(UNIT_LR_MIN_WIDTH, headerMinWidth)
        : Math.max(220, headerMinWidth, streamRowMinWidth, taskRowMinWidthTb);

    if (layoutMode === "lr") {
      const maxMainRows = Math.max(1, inputs, outputs, tasks);
      const height = Math.max(
        126,
        UNIT_NODE_HEADER_HEIGHT
          + 16
          + maxMainRows * 30
          + (unknown > 0 ? STREAM_NODE_HEIGHT + 12 : 0)
          + 12
      );
      ownerSizeById.set(`unit:${unit.address}`, { width, height });
      continue;
    }

    const verticalRows = Math.max(
      1,
      (inputs > 0 ? 1 : 0)
      + (tasks > 0 ? 1 : 0)
      + (unknown > 0 ? 1 : 0)
      + (outputs > 0 ? 1 : 0)
    );
    const height = Math.max(
      216,
      UNIT_NODE_HEADER_HEIGHT
        + 18
        + verticalRows * STREAM_NODE_HEIGHT
        + Math.max(0, verticalRows - 1) * 12
        + 16
    );
    ownerSizeById.set(`unit:${unit.address}`, { width, height });
  }
  for (const collection of visibleCollections.values()) {
    const inputStreams = collection.streams.filter((stream) => stream.direction === "input");
    const outputStreams = collection.streams.filter((stream) => stream.direction === "output");
    const neutralStreams = collection.streams.filter(isNeutralCollectionStream);
    const inputs = inputStreams.length;
    const outputs = outputStreams.length;
    const neutral = neutralStreams.length;
    const rowLanes = laneCount(inputStreams, neutralStreams, outputStreams);
    const maxRows = Math.max(1, inputs, outputs, neutral);
    const streamDrivenWidth = Math.max(
      layoutMode === "lr" ? COLLECTION_NODE_WIDTH : 300,
      requiredRowWidth(
        maxRows,
        STREAM_NODE_WIDTH,
        STREAM_ROW_GAP,
        22
      )
    );
    const headerMinWidth = estimateCollectionHeaderMinWidth(
      collection.name,
      collection.componentType,
      shortType
    );
    const width = Math.max(streamDrivenWidth, headerMinWidth);
    const height = layoutMode === "lr"
      ? Math.max(
        124,
        COLLECTION_NODE_HEADER_HEIGHT
          + 16
          + Math.max(1, inputs, neutral, outputs) * 30
          + 12
      )
      : Math.max(
        176,
        COLLECTION_NODE_HEADER_HEIGHT
          + 18
          + rowLanes * STREAM_NODE_HEIGHT
          + Math.max(0, rowLanes - 1) * 12
          + 16
      );
    ownerSizeById.set(`collection:${collection.address}`, { width, height });
  }
  for (const stream of scopedNeutralStreams) {
    ownerSizeById.set(scopedNeutralStreamOwnerId(stream.address), {
      width: STREAM_NODE_WIDTH,
      height: STREAM_NODE_HEIGHT,
    });
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
    stroke: darkMode ? "#8fa3bc" : "#475569",
    strokeWidth: 1.5,
  };
  const internalMarker = {
    type: MarkerType.ArrowClosed as const,
    width: 12,
    height: 12,
    color: darkMode ? "#8fa3bc" : "#475569",
  };

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
      const visual = streamNodeVisualStyle(stream, className, ownerKind, darkMode);
      const left = startX + index * (STREAM_NODE_WIDTH + gap);
      nodesOut.push({
        id: `stream:${stream.address}`,
        parentNode: unitOwnerId,
        extent: "parent",
        draggable: false,
        data: {
          label: (
            <span
              className={streamLabelClassName(stream, className, ownerKind)}
              title={streamTooltip(stream, ownerKind)}
            >
              <span className="topology-stream-name">
                {streamDisplayName(stream.name, stream.address)}
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
          padding: "0 6px",
        },
      });
    });
  }

  if (scopedCollection && scopedCollectionOwnerId) {
    const scopedOwnerIds = orderedOwnerIds.filter(
      (ownerId) =>
        ownerId.startsWith("unit:")
        || ownerId.startsWith("collection:")
        || scopedNeutralStreamByOwnerId.has(ownerId)
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

    const scopedInputs = scopedCollection.streams.filter((stream) => stream.direction === "input");
    const scopedOutputs = scopedCollection.streams.filter((stream) => stream.direction === "output");
    const scopedStreamMax = Math.max(
      1,
      scopedInputs.length,
      scopedOutputs.length
    );
    const scopedRowMinWidth = requiredRowWidth(
      scopedStreamMax,
      STREAM_NODE_WIDTH,
      STREAM_ROW_GAP,
      24
    );
    const hasScopedInputRow = scopedInputs.length > 0;
    const hasScopedOutputRow = scopedOutputs.length > 0;
    const scopedStreamTop = layoutMode === "lr" ? 72 : 76;
    const scopedHeaderBase = layoutMode === "lr" ? 108 : 64;

    const scopePaddingX = 28;
    const scopeHeaderHeight = layoutMode === "lr"
      ? Math.max(
        scopedHeaderBase,
        scopedStreamTop
          + Math.max(1, scopedInputs.length, scopedOutputs.length) * 30
          + 8
      )
      : Math.max(
        scopedHeaderBase,
        scopedStreamTop + (hasScopedInputRow ? STREAM_NODE_HEIGHT + 8 : 0)
      );
    const scopeBottomPadding = layoutMode === "tb"
      ? hasScopedOutputRow
        ? Math.max(COLLECTION_SCOPE_BOTTOM_PADDING, STREAM_NODE_HEIGHT + 20)
        : 20
      : COLLECTION_SCOPE_BOTTOM_PADDING;
    const scopeContentHeight = Math.max(0, maxY - minY);
    const scopePos = {
      x: minX - scopePaddingX,
      y: minY - scopeHeaderHeight,
    };
    const scopeSize = {
      width: Math.max(360, maxX - minX + scopePaddingX * 2, scopedRowMinWidth + scopePaddingX * 2),
      height: Math.max(180, scopeContentHeight + scopeHeaderHeight + scopeBottomPadding),
    };
    if (scopedOwnerIds.length > 0) {
      const contentCenterX = (minX + maxX) / 2;
      const scopeInnerLeft = scopePos.x + scopePaddingX;
      const scopeInnerRight = scopePos.x + scopeSize.width - scopePaddingX;
      const scopeInnerCenterX = (scopeInnerLeft + scopeInnerRight) / 2;
      const centerShift = Math.round(scopeInnerCenterX - contentCenterX);
      if (centerShift !== 0) {
        for (const ownerId of scopedOwnerIds) {
          const position = ownerPosition.get(ownerId);
          if (!position) {
            continue;
          }
          ownerPosition.set(ownerId, { x: position.x + centerShift, y: position.y });
        }
      }
    }

    nodes.push({
      id: scopedCollectionOwnerId,
      position: scopePos,
      sourcePosition: layoutMode === "tb" ? Position.Bottom : Position.Right,
      targetPosition: layoutMode === "tb" ? Position.Top : Position.Left,
      data: {
        label: (
          <div
            className="topology-collection-label topology-collection-label--scope"
            title={componentTooltip(
              scopedCollection.name,
              scopedCollection.address,
              scopedCollection.componentType
            )}
          >
            <span className="topology-title-row topology-title-row--collection">
              <span className="topology-title-row">
                <strong>{scopedCollection.name}</strong>
                <span
                  className="topology-unit-type"
                  title={scopedCollection.componentType}
                >
                  {shortType(scopedCollection.componentType)}
                </span>
              </span>
              <button
                type="button"
                data-scope-up="true"
                className="topology-collection-scope-up-btn nodrag nopan"
                title="Go up one scope"
                aria-label={`Go up from ${scopedCollection.name}`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onMouseDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  buttonActions?.goUpFromScope?.(scopedCollection.address);
                }}
              >
                ↑ Up
              </button>
            </span>
            <span className="mono">{compactCollectionAddress(scopedCollection.address)}</span>
          </div>
        ),
      },
      style: {
        width: scopeSize.width,
        height: scopeSize.height,
        border: `2px dashed ${darkMode ? "#4b647e" : COLLECTION_BORDER[0]}`,
        borderRadius: 14,
        background: darkMode ? "rgba(15, 23, 42, 0.45)" : "rgba(226, 232, 240, 0.24)",
        color: darkMode ? "#e2e8f0" : "#0f172a",
        padding: 10,
        zIndex: -1,
      },
      draggable: false,
      selectable: false,
    });

    if (layoutMode === "lr") {
      const rowStep = 30;
      const maxRows = Math.max(1, scopedInputs.length, scopedOutputs.length);
      const blockHeight = maxRows * rowStep;
      const top = Math.max(
        scopedStreamTop,
        scopeHeaderHeight - blockHeight - 8
      );
      scopedInputs.forEach((stream, index) => {
        const visual = streamNodeVisualStyle(stream, "is-input", "collection", darkMode);
        nodes.push({
          id: `stream:${stream.address}`,
          parentNode: scopedCollectionOwnerId,
          extent: "parent",
          draggable: false,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          data: {
            label: (
              <span
                className={streamLabelClassName(stream, "is-input", "collection")}
                title={streamTooltip(stream, "collection")}
              >
                <span className="topology-stream-name">
                  {streamDisplayName(stream.name, stream.address)}
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
            padding: "0 6px",
          },
        });
      });
      scopedOutputs.forEach((stream, index) => {
        const visual = streamNodeVisualStyle(stream, "is-output", "collection", darkMode);
        nodes.push({
          id: `stream:${stream.address}`,
          parentNode: scopedCollectionOwnerId,
          extent: "parent",
          draggable: false,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          data: {
            label: (
              <span
                className={streamLabelClassName(stream, "is-output", "collection")}
                title={streamTooltip(stream, "collection")}
              >
                <span className="topology-stream-name">
                  {streamDisplayName(stream.name, stream.address)}
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
            padding: "0 6px",
          },
        });
      });
    } else {
      const topInputY = scopedStreamTop;
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
    }

    for (const ownerId of scopedOwnerIds) {
      const stream = scopedNeutralStreamByOwnerId.get(ownerId);
      if (!stream) {
        continue;
      }
      const position = ownerPosition.get(ownerId);
      if (!position) {
        continue;
      }
      const visual = streamNodeVisualStyle(stream, "is-unknown", "collection", darkMode);
      nodes.push({
        id: ownerId,
        parentNode: scopedCollectionOwnerId,
        extent: "parent",
        draggable: false,
        data: {
          label: (
            <span
              className={streamLabelClassName(stream, "is-unknown", "collection")}
              title={streamTooltip(stream, "collection")}
            >
              <span className="topology-stream-name">
                {streamDisplayName(stream.name, stream.address)}
              </span>
              {compactMsgType(stream.msgType) ? (
                <span className="topology-stream-type">[{compactMsgType(stream.msgType)}]</span>
              ) : null}
            </span>
          ),
        },
        position: { x: position.x - scopePos.x, y: position.y - scopePos.y },
        sourcePosition: layoutMode === "tb" ? Position.Bottom : Position.Right,
        targetPosition: layoutMode === "tb" ? Position.Top : Position.Left,
        style: {
          width: STREAM_NODE_WIDTH,
          height: STREAM_NODE_HEIGHT,
          borderRadius: visual.borderRadius,
          border: visual.border,
          background: visual.background,
          color: visual.color,
          fontSize: 8,
          padding: "0 6px",
        },
      });
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
          <div
            className="topology-collection-label"
            title={componentTooltip(
              collection.name,
              collection.address,
              collection.componentType
            )}
          >
            <span className="topology-title-row topology-title-row--collection">
              <span className="topology-title-row">
                <strong>{collection.name}</strong>
                <span
                  className="topology-unit-type"
                  title={collection.componentType}
                >
                  {shortType(collection.componentType)}
                </span>
              </span>
              <button
                type="button"
                data-open-collection="true"
                className="topology-collection-open-btn nodrag nopan"
                title="Open collection scope"
                aria-label={`Open ${collection.name} scope`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onMouseDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  buttonActions?.openCollectionScope?.(collection.address);
                }}
              >
                Open
              </button>
            </span>
            <span className="mono">{compactCollectionAddress(collection.address)}</span>
          </div>
        ),
      },
      style: {
        width: size.width,
        height: size.height,
        border: `2px dashed ${darkMode ? "#4f8ccf" : COLLECTION_BORDER[1]}`,
        borderRadius: 12,
        background: darkMode ? "rgba(30, 58, 95, 0.34)" : COLLECTION_BG[1],
        color: darkMode ? "#e2e8f0" : "#0f172a",
        padding: 10,
      },
    });

    const inputs = collection.streams.filter((stream) => stream.direction === "input");
    const outputs = collection.streams.filter((stream) => stream.direction === "output");
    const neutral = collection.streams.filter(isNeutralCollectionStream);

    if (layoutMode === "lr") {
      const rowStep = 30;
      const top = COLLECTION_NODE_HEADER_HEIGHT + 6;

      inputs.forEach((stream, index) => {
        const visual = streamNodeVisualStyle(stream, "is-input", "collection", darkMode);
        nodes.push({
          id: `stream:${stream.address}`,
          parentNode: nodeId,
          extent: "parent",
          draggable: false,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          data: {
            label: (
              <span
                className={streamLabelClassName(stream, "is-input", "collection")}
                title={streamTooltip(stream, "collection")}
              >
                <span className="topology-stream-name">
                  {streamDisplayName(stream.name, stream.address)}
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
            padding: "0 6px",
          },
        });
      });

      outputs.forEach((stream, index) => {
        const visual = streamNodeVisualStyle(stream, "is-output", "collection", darkMode);
        nodes.push({
          id: `stream:${stream.address}`,
          parentNode: nodeId,
          extent: "parent",
          draggable: false,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          data: {
            label: (
              <span
                className={streamLabelClassName(stream, "is-output", "collection")}
                title={streamTooltip(stream, "collection")}
              >
                <span className="topology-stream-name">
                  {streamDisplayName(stream.name, stream.address)}
                </span>
                {compactMsgType(stream.msgType) ? (
                  <span className="topology-stream-type">[{compactMsgType(stream.msgType)}]</span>
                ) : null}
              </span>
            ),
          },
          position: { x: size.width - STREAM_NODE_WIDTH - 10, y: top + index * 30 },
          style: {
            width: STREAM_NODE_WIDTH,
            height: STREAM_NODE_HEIGHT,
            borderRadius: visual.borderRadius,
            border: visual.border,
            background: visual.background,
            color: visual.color,
            padding: "0 6px",
          },
        });
      });

      placeUnitStreamRow(
        nodeId,
        size,
        neutral,
        top,
        "is-unknown",
        "collection",
        layoutMode,
        nodes
      );
    } else {
      const topInputY = 86;
      const bottomOutputY = Math.max(
        topInputY + STREAM_NODE_HEIGHT + 10,
        size.height - STREAM_NODE_HEIGHT - 12
      );
      const neutralY = Math.min(
        bottomOutputY - STREAM_NODE_HEIGHT - 12,
        Math.floor((topInputY + bottomOutputY) / 2)
      );
      placeUnitStreamRow(nodeId, size, inputs, topInputY, "is-input", "collection", layoutMode, nodes);
      placeUnitStreamRow(
        nodeId,
        size,
        neutral,
        neutralY,
        "is-unknown",
        "collection",
        layoutMode,
        nodes
      );
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
    }
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
              title={componentTooltip(unit.name, unit.address, unit.componentType)}
            >
              <strong>{unit.name}</strong>
              <span className="topology-unit-type" title={unit.componentType}>
                {shortType(unit.componentType)}
              </span>
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
        border: darkMode ? "1px solid #3b82f6" : "1px solid #93c5fd",
        borderRadius: 12,
        background: darkMode ? "#0f1f35" : "#f8fbff",
        padding: 10,
      },
    });

    if (layoutMode === "lr") {
      const top = UNIT_NODE_HEADER_HEIGHT + 6;

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
              <span
                className="mono topology-stream-label is-input"
                title={streamTooltip(stream, "unit")}
              >
                <span className="topology-stream-name">
                  {streamDisplayName(stream.name, stream.address)}
                </span>
                {compactMsgType(stream.msgType) ? (
                  <span className="topology-stream-type">[{compactMsgType(stream.msgType)}]</span>
                ) : null}
              </span>
            ),
          },
          position: { x: 10, y: top + index * 30 },
          style: {
            width: STREAM_NODE_WIDTH,
            height: STREAM_NODE_HEIGHT,
            borderRadius: 999,
            border: darkMode ? "1px solid #818cf8" : "1px solid #c7d2fe",
            background: darkMode ? "#1d2644" : "#eef2ff",
            padding: "0 6px",
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
              <span
                className="mono topology-stream-label is-output"
                title={streamTooltip(stream, "unit")}
              >
                <span className="topology-stream-name">
                  {streamDisplayName(stream.name, stream.address)}
                </span>
                {compactMsgType(stream.msgType) ? (
                  <span className="topology-stream-type">[{compactMsgType(stream.msgType)}]</span>
                ) : null}
              </span>
            ),
          },
          position: { x: size.width - STREAM_NODE_WIDTH - 10, y: top + index * 30 },
          style: {
            width: STREAM_NODE_WIDTH,
            height: STREAM_NODE_HEIGHT,
            borderRadius: 999,
            border: darkMode ? "1px solid #22d3ee" : "1px solid #7dd3fc",
            background: darkMode ? "#0f2e37" : "#ecfeff",
            padding: "0 6px",
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
          position: { x: Math.floor((size.width - TASK_NODE_WIDTH) / 2), y: top + index * 30 + 4 },
          style: {
            width: TASK_NODE_WIDTH,
            height: TASK_NODE_HEIGHT,
            borderRadius: 999,
            border: darkMode ? "1px solid #41536c" : "1px solid #dbe2ea",
            background: darkMode ? "#1a273a" : "#f1f5f9",
            padding: "0 6px",
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
      const taskBandTop = UNIT_NODE_HEADER_HEIGHT + STREAM_NODE_HEIGHT + 12;
      const bottomOutputY = size.height - STREAM_NODE_HEIGHT - 12;
      const taskBandBottom = bottomOutputY - 8;
      const taskY =
        taskBandTop
        + Math.max(0, Math.floor((taskBandBottom - taskBandTop - TASK_NODE_HEIGHT) / 2));

      placeUnitStreamRow(ownerId, size, inputs, UNIT_NODE_HEADER_HEIGHT + 2, "is-input", "unit", layoutMode, nodes);
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
      const totalTaskWidth = taskCount * TASK_NODE_WIDTH;
      const taskGap =
        taskCount > 1
          ? Math.max(
            TASK_ROW_GAP,
            Math.min(22, Math.floor((taskAvailable - totalTaskWidth) / (taskCount - 1)))
          )
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
          position: { x: taskStart + index * (TASK_NODE_WIDTH + taskGap), y: taskY },
          style: {
            width: TASK_NODE_WIDTH,
            height: TASK_NODE_HEIGHT,
            borderRadius: 999,
            border: darkMode ? "1px solid #41536c" : "1px solid #dbe2ea",
            background: darkMode ? "#1a273a" : "#f1f5f9",
            padding: "0 6px",
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
        border: darkMode ? "1px solid #41536c" : "1px solid #dbe2ea",
        borderRadius: 10,
        background: darkMode ? "#111c2e" : "#ffffff",
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
        color: darkMode ? "#8fa3bc" : "#64748b",
      },
      style: {
        stroke: darkMode ? "#8fa3bc" : "#64748b",
        strokeWidth: 1.2,
      },
    });
  }

  return { nodes, edges };
}
