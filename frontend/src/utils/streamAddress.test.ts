import { describe, expect, it } from "vitest";

import {
  endpointIdFromStreamAddress,
  parseStreamAddress,
  parseTopicAndEndpoint,
  streamAddressWithoutEndpoint,
} from "./streamAddress";

describe("streamAddress helpers", () => {
  it("splits topic and endpoint tokens", () => {
    expect(parseTopicAndEndpoint("SYSTEM/PING_TOPIC:endpoint:1")).toEqual({
      topic: "SYSTEM/PING_TOPIC",
      endpointToken: "endpoint:1",
    });
  });

  it("returns endpoint ids when present", () => {
    expect(endpointIdFromStreamAddress("SYSTEM/PING_TOPIC:endpoint-1")).toBe(
      "endpoint-1"
    );
    expect(endpointIdFromStreamAddress("SYSTEM/PING_TOPIC")).toBeNull();
  });

  it("normalizes stream addresses for inspector routing", () => {
    expect(parseStreamAddress("SYSTEM/PING_TOPIC:endpoint-1")).toEqual({
      topic: "SYSTEM/PING_TOPIC",
      endpointId: "endpoint-1",
    });
    expect(parseStreamAddress("SYSTEM/PING_TOPIC")).toEqual({
      topic: "SYSTEM/PING_TOPIC",
      endpointId: null,
    });
    expect(streamAddressWithoutEndpoint("SYSTEM/PING_TOPIC:endpoint-1")).toBe(
      "SYSTEM/PING_TOPIC"
    );
  });
});
