import { MarkerType } from "reactflow";

import type { GraphSnapshotPayload } from "../types/api";
import { streamAddressWithoutEndpoint } from "../utils/streamAddress";
import type { CollectionComponent, UnitComponent } from "./topologyGraph";
import type { FlowData } from "./topologyFlowData";

export type TopologyComponents = {
  units: Map<string, UnitComponent>;
  collections: Map<string, CollectionComponent>;
};

export function buildCanonicalStreamAliasIndex(
  topologyComponents: TopologyComponents | null
): Map<string, string> {
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
}

export function deriveActiveCanonicalSourceStreams(
  activePublisherStreamAliases: string[],
  canonicalStreamByAlias: Map<string, string>
): Set<string> {
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
}

export function deriveReachableActiveStreams(
  graphSnapshot: GraphSnapshotPayload | null,
  activeCanonicalSourceStreams: Set<string>,
  canonicalStreamByAlias: Map<string, string>
): Set<string> {
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
}

export function applyActiveFlowHighlights(
  flowData: FlowData,
  activeReachableSourceStreams: Set<string>
): FlowData {
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

  return {
    nodes: flowData.nodes,
    edges: flowData.edges.map((edge, index) => {
      if (!activeEdgeIndexes.has(index)) {
        return edge;
      }
      const isInternalEdge =
        typeof edge.className === "string"
        && edge.className.includes("topology-internal-edge");
      if (isInternalEdge) {
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
    }),
  };
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
