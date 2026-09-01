import { describe, expect, it } from "vitest";

import { AutoRange, WindowExtent, laneWindowsEqual, scanColumnExtents } from "./autoRange";
import type { Extent, LaneWindow } from "./autoRange";

const N_CHANNELS = 8;
const N_FEATURES = 2;
const COMPONENTS = 2;

/** Every lane, in order. */
const ALL_LANES: LaneWindow = { offset: 0, stride: 1, count: N_CHANNELS };
/** Feature 0 of each electrode: `(ch, feature)` folds to `ch * 2 + feature`. */
const SPIKE_LANES: LaneWindow = { offset: 0, stride: N_FEATURES, count: 4 };
/** Feature 1 of each electrode. */
const POWER_LANES: LaneWindow = { offset: 1, stride: N_FEATURES, count: 4 };

/**
 * A `(time, ch, feature)` stream whose two features are orders of magnitude
 * apart — spike rate in events/s beside band power in µV².
 *
 * Lanes interleave as ch0/spk, ch0/pow, ch1/spk, ...; the payload is
 * `(columns, n_channels, components)` with the components a min/max pair.
 */
function foldedFrame(columns: number, spikeLevel: number, powerLevel: number): Float32Array {
  const payload = new Float32Array(columns * N_CHANNELS * COMPONENTS);
  for (let column = 0; column < columns; column += 1) {
    for (let channel = 0; channel < N_CHANNELS; channel += 1) {
      const level = channel % N_FEATURES === 0 ? spikeLevel : powerLevel;
      const base = (column * N_CHANNELS + channel) * COMPONENTS;
      payload[base] = -level; // min
      payload[base + 1] = level; // max
    }
  }
  return payload;
}

/** Reduce a frame to one extent over `window`, the way a single push would. */
function frameExtent(
  payload: Float32Array,
  columns: number,
  window: LaneWindow,
  nChannels = N_CHANNELS,
  components = COMPONENTS
): Extent | null {
  const minima = new Float32Array(columns);
  const maxima = new Float32Array(columns);
  scanColumnExtents(payload, { columns, nChannels, components, window }, minima, maxima);
  const extent = new WindowExtent();
  extent.configure(columns);
  extent.writeColumns(0, minima, maxima, columns);
  return extent.extent();
}

describe("scanColumnExtents", () => {
  it("measures only the lanes on screen", () => {
    // The reported bug: with band power in the range, every spike lane clamps
    // flat against a rail, and pinning the feature did not help because the pin
    // only reached the draw path.
    const payload = foldedFrame(4, 100, 12500);

    expect(frameExtent(payload, 4, SPIKE_LANES)).toEqual({ minimum: -100, maximum: 100 });
    expect(frameExtent(payload, 4, POWER_LANES)).toEqual({ minimum: -12500, maximum: 12500 });
    expect(frameExtent(payload, 4, ALL_LANES)).toEqual({ minimum: -12500, maximum: 12500 });
  });

  it("reads every component, so an envelope is bounded by both ends", () => {
    const payload = new Float32Array([-7, 3]);

    expect(frameExtent(payload, 1, { offset: 0, stride: 1, count: 1 }, 1, 2)).toEqual({
      minimum: -7,
      maximum: 3,
    });
  });

  it("honours a contiguous scroll window, not just a strided pin", () => {
    const payload = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]);

    expect(
      frameExtent(payload, 1, { offset: 2, stride: 1, count: 3 }, N_CHANNELS, 1)
    ).toEqual({ minimum: 2, maximum: 4 });
  });

  it("stops at the end of the stream rather than reading past it", () => {
    const payload = new Float32Array([1, 2, 3, 4]);

    // More lanes than exist, which a stale window can ask for.
    expect(frameExtent(payload, 1, { offset: 2, stride: 1, count: 10 }, 4, 1)).toEqual({
      minimum: 3,
      maximum: 4,
    });
  });

  it("reports nothing when nothing finite was seen", () => {
    const payload = new Float32Array([Number.NaN, Number.NaN]);

    expect(frameExtent(payload, 1, { offset: 0, stride: 1, count: 1 }, 1, 2)).toBeNull();
  });
});

describe("WindowExtent", () => {
  /** Two columns whose extent is ±`level`. */
  function columns(level: number, count: number): [Float32Array, Float32Array] {
    return [new Float32Array(count).fill(-level), new Float32Array(count).fill(level)];
  }

  it("spans the whole window, not just the newest columns", () => {
    const extent = new WindowExtent();
    extent.configure(4);
    const [quietMin, quietMax] = columns(1, 2);
    const [loudMin, loudMax] = columns(50, 2);

    extent.writeColumns(0, loudMin, loudMax, 2);
    extent.writeColumns(2, quietMin, quietMax, 2);

    // The loud columns are still on screen, so they still set the scale.
    expect(extent.extent()).toEqual({ minimum: -50, maximum: 50 });
  });

  it("lets a column age out by being overwritten", () => {
    const extent = new WindowExtent();
    extent.configure(2);
    const [loudMin, loudMax] = columns(50, 2);
    const [quietMin, quietMax] = columns(1, 2);

    extent.writeColumns(0, loudMin, loudMax, 2);
    // Wraps and replaces both columns, the way the plot's own ring does.
    extent.writeColumns(2, quietMin, quietMax, 2);

    expect(extent.extent()).toEqual({ minimum: -1, maximum: 1 });
  });

  it("has nothing to say before anything is written", () => {
    const extent = new WindowExtent();
    extent.configure(4);

    expect(extent.extent()).toBeNull();
  });

  it("keeps only what was written after a reset partway round the ring", () => {
    // The case a `filled`-count version got wrong: writes land at the ring's
    // current position, so after a mid-window reset the slots at the start of
    // the array still hold the old lanes' extents.
    const extent = new WindowExtent();
    extent.configure(8);
    const [loudMin, loudMax] = columns(12500, 8);
    extent.writeColumns(0, loudMin, loudMax, 8);

    extent.reset();
    const [quietMin, quietMax] = columns(100, 2);
    extent.writeColumns(5, quietMin, quietMax, 2);

    expect(extent.extent()).toEqual({ minimum: -100, maximum: 100 });
  });

  it("forgets everything on reset, so stale lanes cannot set the scale", () => {
    const extent = new WindowExtent();
    extent.configure(4);
    const [loudMin, loudMax] = columns(12500, 4);
    extent.writeColumns(0, loudMin, loudMax, 4);

    extent.reset();

    expect(extent.extent()).toBeNull();
  });

  it("replaces the whole window for a mode that redraws rather than scrolls", () => {
    const extent = new WindowExtent();
    extent.configure(4);
    const [loudMin, loudMax] = columns(50, 4);
    extent.writeColumns(0, loudMin, loudMax, 4);

    const [quietMin, quietMax] = columns(2, 2);
    extent.replaceAll(quietMin, quietMax, 2);

    expect(extent.extent()).toEqual({ minimum: -2, maximum: 2 });
  });
});

describe("AutoRange", () => {
  it("snaps to the first observation", () => {
    const range = new AutoRange();
    range.observe({ minimum: -100, maximum: 100 });

    expect(range.halfRange).toBeCloseTo(100);
    expect(range.center).toBeCloseTo(0);
  });

  it("expands at once", () => {
    const range = new AutoRange();
    range.observe({ minimum: -1, maximum: 1 });
    range.observe({ minimum: -100, maximum: 100 });

    expect(range.halfRange).toBeCloseTo(100);
  });

  it("snaps again after a reset", () => {
    const range = new AutoRange();
    range.observe({ minimum: -12500, maximum: 12500 });
    range.reset();
    range.observe({ minimum: -100, maximum: 100 });

    expect(range.halfRange).toBeCloseTo(100);
  });

  it("keeps its range when a frame carries nothing finite", () => {
    const range = new AutoRange();
    range.observe({ minimum: -5, maximum: 5 });
    range.observe(null);

    expect(range.halfRange).toBeCloseTo(5);
  });
});

describe("a folded stream with a 100x split between its features", () => {
  const COLUMNS = 4;

  it("scales to the pinned feature instead of the loudest one", () => {
    const payload = foldedFrame(COLUMNS, 100, 12500);
    const range = new AutoRange();

    // Watching everything: band power sets the scale, and it should.
    range.observe(frameExtent(payload, COLUMNS, ALL_LANES));
    expect(range.halfRange).toBeCloseTo(12500);

    // Pinning the spike feature must rescale *now*. The tracker only contracts
    // gradually, so without the reset every spike lane would stay flat against
    // the rail while it eased down.
    range.reset();
    range.observe(frameExtent(payload, COLUMNS, SPIKE_LANES));

    expect(range.halfRange).toBeCloseTo(100);
  });

  it("would otherwise stay stuck near the loud feature's range", () => {
    // The failure mode, spelled out: contraction alone is far too slow.
    const payload = foldedFrame(COLUMNS, 100, 12500);
    const range = new AutoRange();
    range.observe(frameExtent(payload, COLUMNS, ALL_LANES));
    for (let frame = 0; frame < 5; frame += 1) {
      range.observe(frameExtent(payload, COLUMNS, SPIKE_LANES));
    }

    expect(range.halfRange).toBeGreaterThan(1000);
  });
});

describe("a slow signal spanning more than one frame", () => {
  it("is scaled to the window's excursion, not one frame's sliver", () => {
    // A frame covers a fraction of a cycle, so its own extent is tiny. Feeding
    // that to the tracker settled it at 6% of what the window needed, and the
    // trace clipped; the window's extent is what the plot is actually showing.
    const columns = 64;
    const amplitude = 40;
    const extent = new WindowExtent();
    extent.configure(columns);
    const range = new AutoRange();

    for (let column = 0; column < columns; column += 1) {
      const value = 100 + amplitude * Math.sin((2 * Math.PI * column) / columns);
      extent.writeColumns(
        column,
        new Float32Array([value]),
        new Float32Array([value]),
        1
      );
      range.observe(extent.extent());
    }

    // Covers the full excursion once the window has seen it.
    expect(range.halfRange).toBeGreaterThan(amplitude * 0.95);
    expect(range.center).toBeCloseTo(100, 0);
  });
});

describe("laneWindowsEqual", () => {
  it("distinguishes the fields a rescale depends on", () => {
    expect(laneWindowsEqual(SPIKE_LANES, { offset: 0, stride: 2, count: 4 })).toBe(true);
    expect(laneWindowsEqual(SPIKE_LANES, POWER_LANES)).toBe(false);
    expect(laneWindowsEqual(SPIKE_LANES, { ...SPIKE_LANES, count: 8 })).toBe(false);
    expect(laneWindowsEqual(SPIKE_LANES, { ...SPIKE_LANES, stride: 1 })).toBe(false);
  });
});
