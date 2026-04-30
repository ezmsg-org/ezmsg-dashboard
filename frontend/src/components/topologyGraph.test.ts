import { describe, expect, it } from "vitest";

import {
  belongsToCollection,
  buildCollectionParentMap,
  collectionHasVisibleChildren,
  collectionScopePath,
  rootScopeHasExternalStreamContext,
  visibleComponentAddresses,
  type CollectionComponent,
  type UnitComponent,
} from "./topologyGraph";
import type { GraphSnapshotPayload } from "../types/api";

function unit(address: string): UnitComponent {
  return {
    address,
    name: address,
    componentType: "fixture.Unit",
    streams: [],
    tasks: [],
  };
}

function collection(address: string, children: string[]): CollectionComponent {
  return {
    address,
    name: address,
    componentType: "fixture.Collection",
    streams: [],
    children,
  };
}

function stream(address: string, direction: "input" | "output" | "unknown" = "unknown") {
  return {
    name: address.split("/").pop() ?? address,
    address,
    direction,
    msgType: "builtins.str",
    collectionKind: null,
    relayMetadataType: null,
    relayGroup: null,
    relayInputTopic: null,
    relayOutputTopic: null,
  } as const;
}

describe("topologyGraph helpers", () => {
  it("builds nested scope paths and parent membership", () => {
    const collections = new Map<string, CollectionComponent>([
      ["LAB", collection("LAB", ["LAB/PIPELINE"])],
      ["LAB/PIPELINE", collection("LAB/PIPELINE", ["LAB/PIPELINE/INNER"])],
      ["LAB/PIPELINE/INNER", collection("LAB/PIPELINE/INNER", ["LAB/PIPELINE/INNER/SINK"])],
    ]);

    const parentMap = buildCollectionParentMap(collections);
    expect(collectionScopePath(collections, "LAB/PIPELINE/INNER")).toEqual([
      "LAB",
      "LAB/PIPELINE",
      "LAB/PIPELINE/INNER",
    ]);
    expect(
      belongsToCollection("LAB/PIPELINE/INNER/SINK", "LAB", parentMap)
    ).toBe(true);
  });

  it("computes visible addresses for root and scoped views", () => {
    const units = new Map<string, UnitComponent>([
      ["CONTROL/PROBE", unit("CONTROL/PROBE")],
      ["LAB/PIPELINE/SOURCE", unit("LAB/PIPELINE/SOURCE")],
    ]);
    const collections = new Map<string, CollectionComponent>([
      ["LAB", collection("LAB", ["LAB/PIPELINE"])],
      ["LAB/PIPELINE", collection("LAB/PIPELINE", ["LAB/PIPELINE/SOURCE"])],
    ]);

    expect(visibleComponentAddresses(units, collections, null)).toEqual([
      "LAB",
      "CONTROL/PROBE",
    ]);
    expect(visibleComponentAddresses(units, collections, "LAB")).toEqual([
      "LAB/PIPELINE",
    ]);
    expect(collectionHasVisibleChildren("LAB", units, collections)).toBe(true);
  });

  it("detects external root context when graph streams are not collection-owned", () => {
    const units = new Map<string, UnitComponent>([
      [
        "LAB/PIPELINE/SOURCE",
        {
          ...unit("LAB/PIPELINE/SOURCE"),
          streams: [
            {
              name: "OUTPUT",
              address: "LAB/PIPELINE/TOPIC:source-output",
              direction: "output",
              msgType: "builtins.str",
              collectionKind: null,
              relayMetadataType: null,
              relayGroup: null,
              relayInputTopic: null,
              relayOutputTopic: null,
            },
          ],
        },
      ],
    ]);
    const collections = new Map<string, CollectionComponent>([
      ["LAB", collection("LAB", ["LAB/PIPELINE/SOURCE"])],
    ]);
    const graphSnapshot: GraphSnapshotPayload = {
      graph: {
        "LAB/PIPELINE/TOPIC": ["ORPHAN/TOPIC"],
      },
      edge_owners: [],
      sessions: {},
      processes: {},
    };

    expect(
      rootScopeHasExternalStreamContext(graphSnapshot, units, collections, "LAB")
    ).toBe(true);
  });

  it("treats relay-internal topics as collection-owned root context", () => {
    const units = new Map<string, UnitComponent>([
      [
        "SYSTEM/SOURCE",
        {
          ...unit("SYSTEM/SOURCE"),
          streams: [stream("SYSTEM/SOURCE/OUTPUT:source-output", "output")],
        },
      ],
      [
        "SYSTEM/SINK",
        {
          ...unit("SYSTEM/SINK"),
          streams: [stream("SYSTEM/SINK/INPUT:sink-input", "input")],
        },
      ],
    ]);
    const collections = new Map<string, CollectionComponent>([
      [
        "SYSTEM",
        collection("SYSTEM", [
          "SYSTEM/SOURCE",
          "SYSTEM/PASSTHROUGH",
          "SYSTEM/SINK",
        ]),
      ],
      [
        "SYSTEM/PASSTHROUGH",
        {
          ...collection("SYSTEM/PASSTHROUGH", []),
          streams: [
            {
              ...stream("SYSTEM/PASSTHROUGH/IN", "input"),
              name: "IN",
              collectionKind: "relay",
              relayMetadataType: "InputRelayMetadata",
              relayGroup: "SYSTEM/PASSTHROUGH/__relays__/IN",
              relayInputTopic: "SYSTEM/PASSTHROUGH/__relays__/IN/INPUT",
              relayOutputTopic: "SYSTEM/PASSTHROUGH/__relays__/IN/OUTPUT",
            },
            {
              ...stream("SYSTEM/PASSTHROUGH/OUT", "output"),
              name: "OUT",
              collectionKind: "topic",
            },
          ],
        },
      ],
    ]);
    const graphSnapshot: GraphSnapshotPayload = {
      graph: {
        "SYSTEM/SOURCE/OUTPUT": ["SYSTEM/PASSTHROUGH/__relays__/IN/INPUT"],
        "SYSTEM/PASSTHROUGH/__relays__/IN/OUTPUT": ["SYSTEM/PASSTHROUGH/OUT"],
        "SYSTEM/PASSTHROUGH/OUT": ["SYSTEM/SINK/INPUT"],
      },
      edge_owners: [],
      sessions: {},
      processes: {},
    };

    expect(
      rootScopeHasExternalStreamContext(
        graphSnapshot,
        units,
        collections,
        "SYSTEM"
      )
    ).toBe(false);
  });
});
