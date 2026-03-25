import { parseTopicAndEndpoint, streamAddressWithoutEndpoint } from "../utils/streamAddress";
import type { CollectionComponent, StreamDirection, UnitComponent } from "./topologyGraph";

export type TopologySelectionComponents = {
  units: Map<string, UnitComponent>;
  collections: Map<string, CollectionComponent>;
};

export type StreamSelectionMeta = {
  direction: StreamDirection;
  unitAddress: string;
};

export function buildUnitStreamSelectionIndex(
  topologyComponents: TopologySelectionComponents | null
): Map<string, StreamSelectionMeta> {
  const streamByAddress = new Map<string, StreamSelectionMeta>();
  if (!topologyComponents) {
    return streamByAddress;
  }
  for (const unit of topologyComponents.units.values()) {
    for (const stream of unit.streams) {
      const meta = {
        direction: stream.direction,
        unitAddress: unit.address,
      };
      streamByAddress.set(stream.address, meta);
      streamByAddress.set(streamAddressWithoutEndpoint(stream.address), meta);
    }
  }
  return streamByAddress;
}

export function buildComponentAddressByEndpointId(
  topologyComponents: TopologySelectionComponents | null
): Map<string, string> {
  const index = new Map<string, string>();
  if (!topologyComponents) {
    return index;
  }

  const registerStream = (componentAddress: string, streamAddress: string) => {
    const endpointId = streamAddress.split(":").slice(1).join(":");
    if (endpointId.length > 0 && !index.has(endpointId)) {
      index.set(endpointId, componentAddress);
    }
  };

  for (const unit of topologyComponents.units.values()) {
    for (const stream of unit.streams) {
      registerStream(unit.address, stream.address);
    }
  }
  for (const collection of topologyComponents.collections.values()) {
    for (const stream of collection.streams) {
      registerStream(collection.address, stream.address);
    }
  }

  return index;
}

export function resolveComponentAddressByStreamSelection(
  topologyComponents: TopologySelectionComponents | null,
  kind: "publisher" | "subscriber",
  streamAddress: string
): string | null {
  if (!topologyComponents) {
    return null;
  }

  const { topic, endpointToken } = parseTopicAndEndpoint(streamAddress);
  let bestScore = -1;
  let bestAddress: string | null = null;

  const consider = (
    componentAddress: string,
    candidateStreamAddress: string,
    direction: StreamDirection
  ) => {
    const score = scoreStreamSelection(
      kind,
      candidateStreamAddress,
      direction,
      topic,
      endpointToken
    );
    if (score > bestScore) {
      bestScore = score;
      bestAddress = componentAddress;
    }
  };

  for (const unit of topologyComponents.units.values()) {
    for (const stream of unit.streams) {
      consider(unit.address, stream.address, stream.direction);
    }
  }
  for (const collection of topologyComponents.collections.values()) {
    for (const stream of collection.streams) {
      consider(collection.address, stream.address, stream.direction);
    }
  }

  return bestScore > 0 ? bestAddress : null;
}

export function scoreStreamSelection(
  kind: "publisher" | "subscriber",
  streamAddress: string,
  direction: StreamDirection,
  topic: string,
  endpointToken: string
): number {
  if (kind === "publisher" && direction !== "output") {
    return -1;
  }
  if (kind === "subscriber" && direction !== "input") {
    return -1;
  }

  let score = 0;
  const baseTopic = streamAddressWithoutEndpoint(streamAddress);
  if (topic.length > 0) {
    if (baseTopic === topic) {
      score += 12;
    } else if (streamAddress.startsWith(`${topic}:`)) {
      score += 8;
    } else if (streamAddress.includes(topic)) {
      score += 2;
    }
  }
  if (endpointToken.length > 0) {
    if (streamAddress.endsWith(`:${endpointToken}`)) {
      score += 14;
    } else if (streamAddress.includes(endpointToken)) {
      score += 7;
    }
  }
  return score;
}
