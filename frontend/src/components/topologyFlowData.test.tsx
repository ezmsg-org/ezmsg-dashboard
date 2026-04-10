import { describe, expect, it } from "vitest";

import { dashboardFixtures } from "../fixtures/dashboardFixtures";
import { buildFlowData, validateFlowData, type FlowData, type LayoutMode } from "./topologyFlowData";
import type { GraphSnapshotPayload } from "../types/api";

type Box = {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
};

function numericStyleValue(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function absoluteNodeBoxes(flow: FlowData): Map<string, Box> {
  const nodesById = new Map(flow.nodes.map((node) => [node.id, node]));
  const boxes = new Map<string, Box>();

  const resolve = (nodeId: string): Box => {
    const cached = boxes.get(nodeId);
    if (cached) {
      return cached;
    }
    const node = nodesById.get(nodeId);
    if (!node) {
      throw new Error(`Missing node ${nodeId}`);
    }
    const width = numericStyleValue(node.style?.width);
    const height = numericStyleValue(node.style?.height);
    const parentBox = typeof node.parentNode === "string" ? resolve(node.parentNode) : null;
    const left = (parentBox?.left ?? 0) + node.position.x;
    const top = (parentBox?.top ?? 0) + node.position.y;
    const box = {
      id: node.id,
      left,
      top,
      right: left + width,
      bottom: top + height,
    };
    boxes.set(nodeId, box);
    return box;
  };

  for (const node of flow.nodes) {
    resolve(node.id);
  }

  return boxes;
}

function overlapArea(left: Box, right: Box): number {
  const width = Math.min(left.right, right.right) - Math.max(left.left, right.left);
  const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
  return width > 0 && height > 0 ? width * height : 0;
}

function expectNoOverlap(boxes: Box[], label: string) {
  for (let index = 0; index < boxes.length; index += 1) {
    for (let nextIndex = index + 1; nextIndex < boxes.length; nextIndex += 1) {
      expect(
        overlapArea(boxes[index], boxes[nextIndex]),
        `${label}: ${boxes[index].id} overlaps ${boxes[nextIndex].id}`
      ).toBe(0);
    }
  }
}

function expectBoxesInside(parent: Box, children: Box[], label: string) {
  for (const child of children) {
    expect(child.left, `${label}: ${child.id} extends past left`).toBeGreaterThanOrEqual(
      parent.left
    );
    expect(child.right, `${label}: ${child.id} extends past right`).toBeLessThanOrEqual(
      parent.right
    );
    expect(child.top, `${label}: ${child.id} extends past top`).toBeGreaterThanOrEqual(
      parent.top
    );
    expect(child.bottom, `${label}: ${child.id} extends past bottom`).toBeLessThanOrEqual(
      parent.bottom
    );
  }
}

function flowForFixture(
  fixtureName: string,
  layoutMode: LayoutMode,
  scopeCollectionAddress: string | null = null
): FlowData {
  const fixture = dashboardFixtures[fixtureName];
  if (!fixture) {
    throw new Error(`Missing fixture ${fixtureName}`);
  }
  return buildFlowData(
    fixture.snapshot.snapshot,
    layoutMode,
    scopeCollectionAddress,
    "curved",
    false
  );
}

function inputStream(address: string) {
  return {
    name: address.split("/").pop() ?? address,
    address,
    msg_type: "builtins.str",
    leaky: false,
    max_queue: 1,
  };
}

function outputStream(address: string) {
  return {
    name: address.split("/").pop() ?? address,
    address,
    msg_type: "builtins.str",
    num_buffers: 4,
    buf_size: 256,
    force_tcp: false,
  };
}

function topicStream(address: string) {
  return {
    name: address.split("/").pop() ?? address,
    address,
    msg_type: "builtins.str",
  };
}

function relayStream(
  address: string,
  metadataType: "RelayMetadata" | "InputRelayMetadata" | "OutputRelayMetadata",
  relayInputTopic: string,
  relayOutputTopic: string,
  extra: Record<string, unknown> = {}
) {
  return {
    name: address.split("/").pop() ?? address,
    address,
    msg_type: "builtins.str",
    metadata_type: metadataType,
    relay_group: relayInputTopic.split("/").slice(0, -1).join("/"),
    relay_input_topic: relayInputTopic,
    relay_output_topic: relayOutputTopic,
    ...extra,
  };
}

function relayCollapseSnapshot(
  graph: Record<string, string[]>,
  component: Record<string, unknown>
): GraphSnapshotPayload {
  return {
    graph,
    edge_owners: [],
    sessions: {
      "relay-session": {
        edges: [],
        metadata: {
          components: {
            "SYSTEM/SOURCE": {
              name: "SOURCE",
              component_type: "fixture.Source",
              streams: {
                OUTPUT: outputStream("SYSTEM/SOURCE/OUTPUT:source-output"),
              },
              tasks: [],
            },
            "SYSTEM/PASSTHROUGH": component,
            "SYSTEM/SINK": {
              name: "SINK",
              component_type: "fixture.Sink",
              streams: {
                INPUT: inputStream("SYSTEM/SINK/INPUT:sink-input"),
              },
              tasks: [],
            },
          },
        },
      },
    },
    processes: {},
  };
}

function visibleExternalEdges(flow: FlowData): string[] {
  return flow.edges
    .filter((edge) => edge.className !== "topology-internal-edge")
    .map((edge) => `${edge.source}->${edge.target}`)
    .sort();
}

describe("topologyFlowData", () => {
  it("lays out dense unit internals without overlap in both layouts", () => {
    for (const layoutMode of ["tb", "lr"] as LayoutMode[]) {
      const flow = flowForFixture("dense-unit-layout", layoutMode, "MATRIX");
      expect(validateFlowData(flow)).toBe(true);

      const boxes = absoluteNodeBoxes(flow);
      const routerBox = boxes.get("unit:MATRIX/ROUTER");
      expect(routerBox).toBeDefined();
      const childBoxes = Array.from(boxes.values()).filter(
        (box) =>
          box.id.startsWith("stream:MATRIX/IN_")
          || box.id.startsWith("stream:MATRIX/OUT_")
          || box.id.startsWith("task:MATRIX/ROUTER:")
      );
      expect(childBoxes).toHaveLength(36);
      expectBoxesInside(routerBox!, childBoxes, `dense unit ${layoutMode}`);
      expectNoOverlap(childBoxes, `dense unit ${layoutMode}`);
    }
  });

  it("keeps massive fanout owner nodes separated in both layouts", () => {
    for (const layoutMode of ["tb", "lr"] as LayoutMode[]) {
      const flow = flowForFixture("massive-fanout", layoutMode, "MEGA");
      expect(validateFlowData(flow)).toBe(true);

      const boxes = absoluteNodeBoxes(flow);
      const ownerBoxes = Array.from(boxes.values()).filter((box) =>
        box.id.startsWith("unit:MEGA/")
      );
      expect(ownerBoxes).toHaveLength(25);
      expectNoOverlap(ownerBoxes, `massive fanout ${layoutMode}`);
    }
  });

  it("does not let the lr hub width balloon with stacked fanout lanes", () => {
    const flow = flowForFixture("massive-fanout", "lr", "MEGA");
    expect(validateFlowData(flow)).toBe(true);

    const boxes = absoluteNodeBoxes(flow);
    const hubBox = boxes.get("unit:MEGA/HUB");
    expect(hubBox).toBeDefined();
    expect(hubBox!.right - hubBox!.left).toBeLessThanOrEqual(420);
  });

  it("renders cyclic feedback owners without overlap in both layouts", () => {
    for (const layoutMode of ["tb", "lr"] as LayoutMode[]) {
      const flow = flowForFixture("cyclic-feedback", layoutMode);
      expect(validateFlowData(flow)).toBe(true);

      const boxes = absoluteNodeBoxes(flow);
      const ownerBoxes = Array.from(boxes.values()).filter((box) =>
        box.id === "unit:ALPHA"
        || box.id === "unit:BETA"
        || box.id === "unit:GAMMA"
        || box.id === "unit:MONITOR"
      );
      expect(ownerBoxes).toHaveLength(4);
      expectNoOverlap(ownerBoxes, `cyclic feedback ${layoutMode}`);
    }
  });

  it("keeps scoped collection topics from colliding with child owners in nested scopes", () => {
    const flow = flowForFixture("nested-collections", "tb", "LAB/PIPELINE");

    const boxes = absoluteNodeBoxes(flow);
    const sourceBox = boxes.get("unit:LAB/PIPELINE/SOURCE");
    const innerBox = boxes.get("collection:LAB/PIPELINE/INNER");
    const rootTopicBox = boxes.get("stream:LAB/PIPELINE/ROOT_TOPIC");

    expect(sourceBox).toBeDefined();
    expect(innerBox).toBeDefined();
    expect(rootTopicBox).toBeDefined();

    expect(
      overlapArea(sourceBox!, rootTopicBox!),
      "nested scope: ROOT_TOPIC overlaps SOURCE"
    ).toBe(0);
    expect(
      overlapArea(innerBox!, rootTopicBox!),
      "nested scope: ROOT_TOPIC overlaps INNER"
    ).toBe(0);
  });

  it("collapses neutral relay runtime topics to the relay endpoint", () => {
    const flow = buildFlowData(
      relayCollapseSnapshot(
        {
          "SYSTEM/SOURCE/OUTPUT": ["SYSTEM/PASSTHROUGH/IN"],
          "SYSTEM/PASSTHROUGH/IN": ["SYSTEM/PASSTHROUGH/MID"],
          "SYSTEM/PASSTHROUGH/MID": ["SYSTEM/PASSTHROUGH/OUT", "SYSTEM/PASSTHROUGH/__relays__/MID/INPUT"],
          "SYSTEM/PASSTHROUGH/__relays__/MID/OUTPUT": ["SYSTEM/PASSTHROUGH/MID"],
          "SYSTEM/PASSTHROUGH/OUT": ["SYSTEM/SINK/INPUT"],
        },
        {
          name: "PASSTHROUGH",
          component_type: "fixture.Passthrough",
          children: [],
          topics: {
            IN: topicStream("SYSTEM/PASSTHROUGH/IN"),
            OUT: topicStream("SYSTEM/PASSTHROUGH/OUT"),
          },
          relays: {
            MID: relayStream(
              "SYSTEM/PASSTHROUGH/MID",
              "RelayMetadata",
              "SYSTEM/PASSTHROUGH/__relays__/MID/INPUT",
              "SYSTEM/PASSTHROUGH/__relays__/MID/OUTPUT",
              {
                leaky: true,
                max_queue: 9,
                num_buffers: 6,
              }
            ),
          },
        }
      ),
      "tb",
      null,
      "curved",
      false
    );

    expect(validateFlowData(flow)).toBe(true);
    expect(flow.nodes.some((node) => node.id.includes("__relays__"))).toBe(false);
    expect(flow.edges.some((edge) => edge.id.includes("__relays__"))).toBe(false);
    expect(visibleExternalEdges(flow)).toEqual([
      "stream:SYSTEM/PASSTHROUGH/IN->stream:SYSTEM/PASSTHROUGH/MID",
      "stream:SYSTEM/PASSTHROUGH/OUT->stream:SYSTEM/SINK/INPUT:sink-input",
      "stream:SYSTEM/PASSTHROUGH/MID->stream:SYSTEM/PASSTHROUGH/OUT",
      "stream:SYSTEM/SOURCE/OUTPUT:source-output->stream:SYSTEM/PASSTHROUGH/IN",
    ]);
  });

  it("collapses input relay runtime topics to the collection boundary endpoints", () => {
    const flow = buildFlowData(
      relayCollapseSnapshot(
        {
          "SYSTEM/SOURCE/OUTPUT": ["SYSTEM/PASSTHROUGH/IN"],
          "SYSTEM/PASSTHROUGH/IN": ["SYSTEM/PASSTHROUGH/__relays__/IN/INPUT"],
          "SYSTEM/PASSTHROUGH/__relays__/IN/OUTPUT": ["SYSTEM/PASSTHROUGH/OUT"],
          "SYSTEM/PASSTHROUGH/OUT": ["SYSTEM/SINK/INPUT"],
        },
        {
          name: "PASSTHROUGH",
          component_type: "fixture.Passthrough",
          children: [],
          topics: {
            OUT: topicStream("SYSTEM/PASSTHROUGH/OUT"),
          },
          relays: {
            IN: relayStream(
              "SYSTEM/PASSTHROUGH/IN",
              "InputRelayMetadata",
              "SYSTEM/PASSTHROUGH/__relays__/IN/INPUT",
              "SYSTEM/PASSTHROUGH/__relays__/IN/OUTPUT",
              {
                leaky: true,
                max_queue: 7,
              }
            ),
          },
        }
      ),
      "tb",
      null,
      "curved",
      false
    );

    expect(validateFlowData(flow)).toBe(true);
    expect(flow.nodes.some((node) => node.id.includes("__relays__"))).toBe(false);
    expect(flow.edges.some((edge) => edge.id.includes("__relays__"))).toBe(false);
    expect(visibleExternalEdges(flow)).toEqual([
      "stream:SYSTEM/PASSTHROUGH/IN->stream:SYSTEM/PASSTHROUGH/OUT",
      "stream:SYSTEM/PASSTHROUGH/OUT->stream:SYSTEM/SINK/INPUT:sink-input",
      "stream:SYSTEM/SOURCE/OUTPUT:source-output->stream:SYSTEM/PASSTHROUGH/IN",
    ]);
  });

  it("collapses output relay runtime topics to the collection boundary endpoints", () => {
    const flow = buildFlowData(
      relayCollapseSnapshot(
        {
          "SYSTEM/SOURCE/OUTPUT": ["SYSTEM/PASSTHROUGH/IN"],
          "SYSTEM/PASSTHROUGH/IN": ["SYSTEM/PASSTHROUGH/__relays__/OUT/INPUT"],
          "SYSTEM/PASSTHROUGH/__relays__/OUT/OUTPUT": ["SYSTEM/PASSTHROUGH/OUT"],
          "SYSTEM/PASSTHROUGH/OUT": ["SYSTEM/SINK/INPUT"],
        },
        {
          name: "PASSTHROUGH",
          component_type: "fixture.Passthrough",
          children: [],
          topics: {
            IN: topicStream("SYSTEM/PASSTHROUGH/IN"),
          },
          relays: {
            OUT: relayStream(
              "SYSTEM/PASSTHROUGH/OUT",
              "OutputRelayMetadata",
              "SYSTEM/PASSTHROUGH/__relays__/OUT/INPUT",
              "SYSTEM/PASSTHROUGH/__relays__/OUT/OUTPUT",
              {
                num_buffers: 8,
                force_tcp: true,
              }
            ),
          },
        }
      ),
      "tb",
      null,
      "curved",
      false
    );

    expect(validateFlowData(flow)).toBe(true);
    expect(flow.nodes.some((node) => node.id.includes("__relays__"))).toBe(false);
    expect(flow.edges.some((edge) => edge.id.includes("__relays__"))).toBe(false);
    expect(visibleExternalEdges(flow)).toEqual([
      "stream:SYSTEM/PASSTHROUGH/IN->stream:SYSTEM/PASSTHROUGH/OUT",
      "stream:SYSTEM/PASSTHROUGH/OUT->stream:SYSTEM/SINK/INPUT:sink-input",
      "stream:SYSTEM/SOURCE/OUTPUT:source-output->stream:SYSTEM/PASSTHROUGH/IN",
    ]);
  });
});
