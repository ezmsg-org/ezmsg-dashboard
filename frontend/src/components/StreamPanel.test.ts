import { describe, expect, it } from "vitest";

import { looksUndecodable } from "./StreamPanel";

describe("looksUndecodable", () => {
  it("reports a publisher that is sending while the tap receives nothing", () => {
    expect(
      looksUndecodable({ messageCount: 0, publisherRateHz: 2, elapsedMs: 10_000 })
    ).toBe(true);
  });

  it("stays quiet about a genuinely idle topic", () => {
    // Nothing is being published, so there is nothing to explain.
    expect(
      looksUndecodable({ messageCount: 0, publisherRateHz: 0, elapsedMs: 10_000 })
    ).toBe(false);
    expect(
      looksUndecodable({ messageCount: 0, publisherRateHz: null, elapsedMs: 10_000 })
    ).toBe(false);
  });

  it("stays quiet once messages have actually arrived", () => {
    expect(
      looksUndecodable({ messageCount: 1, publisherRateHz: 2, elapsedMs: 10_000 })
    ).toBe(false);
  });

  it("gives a newly opened panel time to receive its first message", () => {
    expect(
      looksUndecodable({ messageCount: 0, publisherRateHz: 2, elapsedMs: 500 })
    ).toBe(false);
  });
});
