import { describe, expect, it } from "vitest";

import type { FlowData } from "./topologyFlowData";
import { inferFocusComponentAddress, resolveFocusNodeId } from "./useTopologyFocus";

const emptyFlowData: FlowData = {
  nodes: [],
  edges: [],
};

describe("useTopologyFocus helpers", () => {
  it("infers component addresses for stream selections from endpoint ids", () => {
    const endpointIndex = new Map<string, string>([
      ["ping-output-endpoint", "SYSTEM/PING"],
    ]);

    const resolved = inferFocusComponentAddress(
      {
        kind: "publisher",
        streamAddress: "SYSTEM/PING_TOPIC:ping-output-endpoint",
        unitAddress: null,
      },
      endpointIndex,
      () => null
    );

    expect(resolved).toBe("SYSTEM/PING");
  });

  it("prefers matching unit nodes when the inferred component is visible", () => {
    const nodeId = resolveFocusNodeId(
      {
        kind: "publisher",
        streamAddress: "SYSTEM/PING_TOPIC:ping-output-endpoint",
        unitAddress: null,
      },
      "SYSTEM/PING",
      {
        nodes: [{ id: "unit:SYSTEM/PING", position: { x: 0, y: 0 }, data: {} }],
        edges: [],
      },
      {
        units: new Map([["SYSTEM/PING", { address: "SYSTEM/PING", name: "PING", componentType: "fixture.Unit", streams: [], tasks: [] }]]),
        collections: new Map(),
      }
    );

    expect(nodeId).toBe("unit:SYSTEM/PING");
  });

  it("falls back to stream nodes when no component address can be inferred", () => {
    const nodeId = resolveFocusNodeId(
      {
        kind: "subscriber",
        streamAddress: "GLOBAL/TOPIC:listener-1",
        unitAddress: null,
      },
      null,
      {
        nodes: [{ id: "stream:GLOBAL/TOPIC:listener-1", position: { x: 0, y: 0 }, data: {} }],
        edges: [],
      },
      null
    );

    expect(nodeId).toBe("stream:GLOBAL/TOPIC:listener-1");
    expect(emptyFlowData.nodes).toHaveLength(0);
  });
});
