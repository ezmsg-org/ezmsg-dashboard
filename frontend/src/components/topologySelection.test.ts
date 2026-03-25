import { describe, expect, it } from "vitest";

import { dashboardFixtures } from "../fixtures/dashboardFixtures";
import { classifyComponents } from "./topologyGraph";
import {
  buildComponentAddressByEndpointId,
  buildUnitStreamSelectionIndex,
  resolveComponentAddressByStreamSelection,
  scoreStreamSelection,
} from "./topologySelection";

describe("topologySelection", () => {
  it("indexes unit stream aliases with and without endpoint ids", () => {
    const snapshot = dashboardFixtures["root-scope-navigation"].snapshot.snapshot;
    const topologyComponents = classifyComponents(snapshot);
    const index = buildUnitStreamSelectionIndex(topologyComponents);

    expect(index.get("SYSTEM/PING_TOPIC:ping-output-endpoint")).toEqual({
      direction: "output",
      unitAddress: "SYSTEM/PING",
    });
    expect(index.get("SYSTEM/PING_TOPIC")).toEqual({
      direction: "output",
      unitAddress: "SYSTEM/PING",
    });
  });

  it("indexes component addresses by endpoint id across units and collections", () => {
    const snapshot = dashboardFixtures["root-scope-navigation"].snapshot.snapshot;
    const topologyComponents = classifyComponents(snapshot);
    const endpointIndex = buildComponentAddressByEndpointId(topologyComponents);

    expect(endpointIndex.get("ping-output-endpoint")).toBe("SYSTEM/PING");
  });

  it("resolves stream selections back to the best matching unit", () => {
    const snapshot = dashboardFixtures["orphan-streams"].snapshot.snapshot;
    const topologyComponents = classifyComponents(snapshot);

    expect(
      resolveComponentAddressByStreamSelection(
        topologyComponents,
        "publisher",
        "SYSTEM/PROCESS_TOPIC:processor-output"
      )
    ).toBe("SYSTEM/PROCESSOR");
    expect(
      resolveComponentAddressByStreamSelection(
        topologyComponents,
        "subscriber",
        "SYSTEM/PROCESS_TOPIC:processor-input"
      )
    ).toBe("SYSTEM/PROCESSOR");
  });

  it("scores exact endpoint and topic matches above partial matches", () => {
    const exact = scoreStreamSelection(
      "publisher",
      "SYSTEM/PING_TOPIC:ping-output-endpoint",
      "output",
      "SYSTEM/PING_TOPIC",
      "ping-output-endpoint"
    );
    const partial = scoreStreamSelection(
      "publisher",
      "SYSTEM/PING_TOPIC:other-endpoint",
      "output",
      "SYSTEM/PING_TOPIC",
      "ping-output-endpoint"
    );

    expect(exact).toBeGreaterThan(partial);
  });
});
