import { describe, expect, it } from "vitest";

import { dashboardFixtures } from "../fixtures/dashboardFixtures";
import { classifyComponents } from "./topologyGraph";
import { buildFlowData } from "./topologyFlowData";
import {
  applyActiveFlowHighlights,
  buildCanonicalStreamAliasIndex,
  deriveActiveCanonicalSourceStreams,
  deriveReachableActiveStreams,
} from "./topologyTrace";

describe("topologyTrace", () => {
  it("builds canonical aliases and expands reachable highlighted streams", () => {
    const snapshot = dashboardFixtures["root-scope-navigation"].snapshot.snapshot;
    const topologyComponents = classifyComponents(snapshot);
    const canonicalIndex = buildCanonicalStreamAliasIndex(topologyComponents);
    const activeCanonical = deriveActiveCanonicalSourceStreams(
      ["SYSTEM/PING_TOPIC:ping-output-endpoint"],
      canonicalIndex
    );
    const reachable = deriveReachableActiveStreams(
      snapshot,
      activeCanonical,
      canonicalIndex
    );

    expect(activeCanonical.has("SYSTEM/PING_TOPIC:ping-output-endpoint")).toBe(true);
    expect(reachable.has("SYSTEM/PING_TOPIC:ping-output-endpoint")).toBe(true);
    expect(reachable.has("SYSTEM/PING_TOPIC")).toBe(true);
    expect(reachable.has("GLOBAL_PING_TOPIC")).toBe(true);
  });

  it("applies highlight styling only to active non-internal edges", () => {
    const snapshot = dashboardFixtures["root-scope-navigation"].snapshot.snapshot;
    const topologyComponents = classifyComponents(snapshot);
    const canonicalIndex = buildCanonicalStreamAliasIndex(topologyComponents);
    const activeCanonical = deriveActiveCanonicalSourceStreams(
      ["SYSTEM/PING_TOPIC:ping-output-endpoint"],
      canonicalIndex
    );
    const reachable = deriveReachableActiveStreams(
      snapshot,
      activeCanonical,
      canonicalIndex
    );
    const flowData = buildFlowData(snapshot, "tb", "SYSTEM", "curved", false);
    const highlighted = applyActiveFlowHighlights(flowData, reachable);

    const animatedEdges = highlighted.edges.filter((edge) => edge.animated);
    expect(animatedEdges.length).toBeGreaterThan(0);
    expect(animatedEdges.every((edge) => edge.className !== "topology-internal-edge")).toBe(
      true
    );
  });
});
