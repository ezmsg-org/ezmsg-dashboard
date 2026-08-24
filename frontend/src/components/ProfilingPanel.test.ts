import { describe, expect, it } from "vitest";

import { topicScopeForPublisher } from "./ProfilingPanel";
import type { GraphSnapshotPayload } from "../types/api";

function graphSnapshot(graph: Record<string, string[]>): GraphSnapshotPayload {
  return {
    graph,
    edge_owners: [],
    sessions: {},
    processes: {},
  } as unknown as GraphSnapshotPayload;
}

describe("topicScopeForPublisher", () => {
  it("follows a forward chain to the topic the subscriber is registered under", () => {
    // HUB/SDA publishes into UCDF, a nested collection: the topic is forwarded
    // once per boundary, so the only topic a subscriber actually holds is two
    // hops out. Stopping at one hop reported the publisher as having no
    // subscribers at all.
    const scope = topicScopeForPublisher(
      "HUB/SDA/OUTPUT_SIGNAL",
      graphSnapshot({
        "HUB/SDA/OUTPUT_SIGNAL": ["HUB/UCDF/INPUT_SIGNAL"],
        "HUB/UCDF/INPUT_SIGNAL": ["HUB/UCDF/BUTTER0/INPUT_SIGNAL"],
        "HUB/UCDF/BUTTER0/INPUT_SIGNAL": [],
      }),
      new Map()
    );

    expect([...scope].sort()).toEqual([
      "HUB/SDA/OUTPUT_SIGNAL",
      "HUB/UCDF/BUTTER0/INPUT_SIGNAL",
      "HUB/UCDF/INPUT_SIGNAL",
    ]);
  });

  it("keeps every branch of a fan-out", () => {
    const scope = topicScopeForPublisher(
      "HUB/LRR/OUTPUT_SIGNAL",
      graphSnapshot({
        "HUB/LRR/OUTPUT_SIGNAL": [
          "HUB/RMS_SQ/INPUT_SIGNAL",
          "HUB/SCALESPK/INPUT_SIGNAL",
        ],
      }),
      new Map()
    );

    expect([...scope].sort()).toEqual([
      "HUB/LRR/OUTPUT_SIGNAL",
      "HUB/RMS_SQ/INPUT_SIGNAL",
      "HUB/SCALESPK/INPUT_SIGNAL",
    ]);
  });

  it("terminates on a cyclic graph", () => {
    const scope = topicScopeForPublisher(
      "A/OUTPUT",
      graphSnapshot({
        "A/OUTPUT": ["B/INPUT"],
        "B/INPUT": ["A/OUTPUT"],
      }),
      new Map()
    );

    expect([...scope].sort()).toEqual(["A/OUTPUT", "B/INPUT"]);
  });

  it("canonicalizes relay aliases along the chain", () => {
    const scope = topicScopeForPublisher(
      "HUB/__relays__/OUTPUT_SIGNAL/OUTPUT",
      graphSnapshot({
        "HUB/__relays__/OUTPUT_SIGNAL/OUTPUT": ["HUB/OUTPUT_SIGNAL"],
        "HUB/OUTPUT_SIGNAL": ["DOWNSTREAM/INPUT_REFERENCE"],
      }),
      new Map([["HUB/__relays__/OUTPUT_SIGNAL/OUTPUT", "HUB/OUTPUT_SIGNAL"]])
    );

    expect(scope.has("DOWNSTREAM/INPUT_REFERENCE")).toBe(true);
    expect(scope.has("HUB/OUTPUT_SIGNAL")).toBe(true);
  });
});
