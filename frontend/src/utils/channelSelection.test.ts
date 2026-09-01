import { describe, expect, it } from "vitest";

import {
  axisStrides,
  channelAt,
  channelSelection,
  isSelectableAxis,
} from "./channelSelection";
import type { ChannelAxis } from "../types/stream";

const CH = { name: "ch", size: 4, labels: ["E0", "E1", "E2", "E3"] };
const FEAT = { name: "feat", size: 2, labels: ["sbp", "rate"] };

/** What the backend's reshape produces, so the test pins the real layout. */
function flatten(axes: ChannelAxis[]): string[] {
  let names = [""];
  for (const axis of axes) {
    const next: string[] = [];
    for (const prefix of names) {
      for (let index = 0; index < axis.size; index += 1) {
        const entry = axis.labels?.[index] ?? `${axis.name}${index}`;
        next.push(prefix ? `${prefix}/${entry}` : entry);
      }
    }
    names = next;
  }
  return names;
}

describe("axisStrides", () => {
  it("gives the step for advancing one entry along each axis", () => {
    expect(axisStrides([CH, FEAT])).toEqual([2, 1]);
    expect(axisStrides([FEAT, CH])).toEqual([4, 1]);
    expect(axisStrides([CH])).toEqual([1]);
  });
});

describe("channelSelection", () => {
  it("selects a feature by stride when channels fold first", () => {
    // (ch, feat) -> ch * 2 + feat, so "rate" is every other channel from 1.
    const axes = [CH, FEAT];
    const selection = channelSelection(axes, 8, 1, 1)!;

    expect(selection).toEqual({ offset: 1, stride: 2, total: 4 });
    const picked = [0, 1, 2, 3].map((lane) => flatten(axes)[channelAt(selection, lane)]);
    expect(picked).toEqual(["E0/rate", "E1/rate", "E2/rate", "E3/rate"]);
  });

  it("selects a feature as a contiguous block when features fold first", () => {
    // (feat, ch) -> feat * 4 + ch, so "rate" is the second block of four.
    const axes = [FEAT, CH];
    const selection = channelSelection(axes, 8, 0, 1)!;

    expect(selection).toEqual({ offset: 4, stride: 1, total: 4 });
    const picked = [0, 1, 2, 3].map((lane) => flatten(axes)[channelAt(selection, lane)]);
    expect(picked).toEqual(["rate/E0", "rate/E1", "rate/E2", "rate/E3"]);
  });

  it("can pin the channel axis instead, leaving the features", () => {
    const axes = [CH, FEAT];
    const selection = channelSelection(axes, 8, 0, 2)!;

    expect(selection).toEqual({ offset: 4, stride: 1, total: 2 });
    const picked = [0, 1].map((lane) => flatten(axes)[channelAt(selection, lane)]);
    expect(picked).toEqual(["E2/sbp", "E2/rate"]);
  });

  it("no pin means every channel, in order", () => {
    const selection = channelSelection([CH, FEAT], 8, null, 0)!;

    expect(selection).toEqual({ offset: 0, stride: 1, total: 8 });
  });

  it("clamps a pin that is out of range rather than reading past the axis", () => {
    const selection = channelSelection([CH, FEAT], 8, 1, 99)!;

    expect(selection.offset).toBe(1);
  });

  it("works with no channel axes reported at all", () => {
    // An older backend, or a stream whose axes could not be described.
    expect(channelSelection([], 32, null, 0)).toEqual({ offset: 0, stride: 1, total: 32 });
  });

  it("refuses a pin that two free axes would make non-arithmetic", () => {
    // Pinning the middle of three leaves two independent counters, which no
    // single stride describes; drawing it anyway would mislabel.
    const axes = [CH, FEAT, { name: "band", size: 3, labels: null }];

    expect(isSelectableAxis(axes, 1)).toBe(false);
    expect(channelSelection(axes, 24, 1, 0)).toBeNull();
  });

  it("allows pinning when only one other axis actually varies", () => {
    const axes = [CH, FEAT, { name: "band", size: 1, labels: ["only"] }];

    expect(isSelectableAxis(axes, 1)).toBe(true);
    expect(channelSelection(axes, 8, 1, 1)).toEqual({ offset: 1, stride: 2, total: 4 });
  });

  it("a pin that names exactly one channel is still a valid selection", () => {
    const axes = [{ name: "ch", size: 1, labels: ["E0"] }, FEAT];

    expect(channelSelection(axes, 2, 1, 1)).toEqual({ offset: 1, stride: 1, total: 1 });
  });
});
