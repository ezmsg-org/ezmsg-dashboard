import type { GraphSnapshotPayload } from "../types/api";
import { streamAddressWithoutEndpoint } from "../utils/streamAddress";

type AnyRecord = Record<string, unknown>;

export type StreamDirection = "input" | "output" | "unknown";

export type UnitComponent = {
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

export type CollectionComponent = {
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

export function classifyComponents(graphSnapshot: GraphSnapshotPayload): {
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

export function computeRanks(
  ownerIds: string[],
  edges: Array<{ from: string; to: string }>
): Map<string, number> {
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

export function visibleComponentAddresses(
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

export function buildCollectionParentMap(
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

export function collectionScopePath(
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

export function collectionHasVisibleChildren(
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

export function belongsToCollection(
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

export function rootScopeHasExternalStreamContext(
  graphSnapshot: GraphSnapshotPayload,
  units: Map<string, UnitComponent>,
  collections: Map<string, CollectionComponent>,
  rootCollectionAddress: string
): boolean {
  const parentByAddress = buildCollectionParentMap(collections);
  const ownerByStreamAddress = new Map<string, string>();
  const registerOwner = (streamAddress: string, ownerAddress: string) => {
    ownerByStreamAddress.set(streamAddress, ownerAddress);
    ownerByStreamAddress.set(streamAddressWithoutEndpoint(streamAddress), ownerAddress);
  };
  for (const unit of units.values()) {
    for (const stream of unit.streams) {
      registerOwner(stream.address, unit.address);
    }
  }
  for (const collection of collections.values()) {
    for (const stream of collection.streams) {
      registerOwner(stream.address, collection.address);
    }
  }

  const streamAddresses = new Set<string>();
  for (const [fromTopic, toTopics] of Object.entries(graphSnapshot.graph)) {
    streamAddresses.add(fromTopic);
    for (const toTopic of toTopics) {
      streamAddresses.add(toTopic);
    }
  }

  for (const streamAddress of streamAddresses) {
    const ownerAddress = ownerByStreamAddress.get(streamAddress);
    if (!ownerAddress) {
      return true;
    }
    if (!belongsToCollection(ownerAddress, rootCollectionAddress, parentByAddress)) {
      return true;
    }
  }
  return false;
}
