/**
 * The vertical scale a sweep is drawn against, tracked over time.
 *
 * Split out of the renderer so it can be tested: the renderer needs a live
 * WebGL context, and the thing most worth checking here — that the scale
 * follows the lanes actually on screen — is pure arithmetic over a payload.
 */

/** The lanes currently drawn: `offset + i * stride` for `i` in `[0, count)`. */
export type LaneWindow = {
  offset: number;
  stride: number;
  count: number;
};

export type Extent = { minimum: number; maximum: number };

export function laneWindowsEqual(a: LaneWindow, b: LaneWindow): boolean {
  return a.offset === b.offset && a.stride === b.stride && a.count === b.count;
}

/**
 * Per-column min/max across only the lanes on screen.
 *
 * Scanning every channel instead is the obvious shortcut and it is wrong for
 * any stream whose channels are not in the same units. A `(time, ch, feature)`
 * stream interleaves lanes: spike rate in events/s alongside band power in µV²,
 * two or three orders of magnitude apart. Let the unseen ones into the range
 * and the visible ones flatten against a rail — and pinning a feature would not
 * rescue it, because the pin changes which lanes are *drawn*, not which are
 * measured.
 *
 * All components of a lane count: for a min/max envelope both ends bound the
 * trace, so reading only one would clip the other.
 *
 * Results are written into caller-provided scratch, per column, because a
 * per-frame figure is not enough — see {@link WindowExtent}.
 */
export function scanColumnExtents(
  payload: Float32Array,
  options: {
    columns: number;
    nChannels: number;
    components: number;
    window: LaneWindow;
  },
  outMinimum: Float32Array,
  outMaximum: Float32Array
): void {
  const { columns, nChannels, components, window } = options;
  const floatsPerColumn = nChannels * components;

  for (let column = 0; column < columns; column += 1) {
    const columnBase = column * floatsPerColumn;
    let minimum = Infinity;
    let maximum = -Infinity;
    for (let lane = 0; lane < window.count; lane += 1) {
      const channel = window.offset + lane * window.stride;
      if (channel >= nChannels) {
        break;
      }
      const base = columnBase + channel * components;
      for (let component = 0; component < components; component += 1) {
        const value = payload[base + component];
        // NaN fails both comparisons, so a broken column contributes nothing
        // rather than poisoning the whole scale.
        if (value < minimum) minimum = value;
        if (value > maximum) maximum = value;
      }
    }
    outMinimum[column] = minimum;
    outMaximum[column] = maximum;
  }
}

/**
 * The extent of every column currently on screen, kept as a ring.
 *
 * The scale has to describe the *window*, and a frame is not the window. A
 * frame covers about a thirtieth of a second; on a slow signal its extent is a
 * sliver of the excursion the plot is showing, so a tracker fed per-frame
 * figures decays between peaks and clips the trace. Measured against the demo
 * signal it settled at 6% of what the window needed.
 *
 * Keeping one min/max per column and reducing over the ring makes the answer
 * exactly "the extent of what is drawn", with no constant to tune. Columns age
 * out by being overwritten, the same way the plot's own history does.
 */
export class WindowExtent {
  private minima = new Float32Array(0);
  private maxima = new Float32Array(0);
  private capacity = 0;

  configure(columns: number): void {
    this.capacity = Math.max(1, columns);
    this.minima = new Float32Array(this.capacity);
    this.maxima = new Float32Array(this.capacity);
    this.reset();
  }

  /**
   * Forget everything measured so far.
   *
   * Used when the lanes change: the stored extents describe channels nobody is
   * looking at any more, and reducing over them would scale the new selection
   * to the old one's amplitude.
   */
  reset(): void {
    // Sentinels rather than a count of written slots. Writes land at the ring's
    // *current* position, so a reset partway round leaves the untouched slots
    // scattered anywhere; a count would make `extent` read whichever slots
    // happened to sit at the start of the array. Empty slots that lose every
    // comparison cannot do that, and they cost nothing to skip.
    this.minima.fill(Number.POSITIVE_INFINITY);
    this.maxima.fill(Number.NEGATIVE_INFINITY);
  }

  /** Append per-column extents at `startColumn`, wrapping like the plot's ring. */
  writeColumns(
    startColumn: number,
    minima: Float32Array,
    maxima: Float32Array,
    count: number
  ): void {
    if (this.capacity === 0) {
      return;
    }
    for (let index = 0; index < count; index += 1) {
      const slot = (startColumn + index) % this.capacity;
      this.minima[slot] = minima[index];
      this.maxima[slot] = maxima[index];
    }
  }

  /** Replace the whole window, for a mode that redraws rather than scrolls. */
  replaceAll(minima: Float32Array, maxima: Float32Array, count: number): void {
    if (this.capacity === 0) {
      return;
    }
    this.reset();
    this.writeColumns(0, minima, maxima, Math.min(count, this.capacity));
  }

  extent(): Extent | null {
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < this.capacity; index += 1) {
      const low = this.minima[index];
      const high = this.maxima[index];
      if (low < minimum) minimum = low;
      if (high > maximum) maximum = high;
    }
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
      return null;
    }
    return { minimum, maximum };
  }
}

/**
 * A smoothed amplitude range: expands at once, contracts slowly.
 *
 * Asymmetric on purpose. Following a shrinking signal down as fast as it falls
 * makes a quiet stretch bloom into full-scale noise and makes the vertical
 * scale meaningless from one second to the next; taking a moment to settle
 * keeps the plot readable while still recovering from a step change.
 *
 * That asymmetry is also why {@link reset} exists. Changing which lanes are on
 * screen can drop the amplitude by orders of magnitude, and easing down from
 * the old range would leave the new selection pinned flat for seconds — long
 * enough to look broken rather than slow.
 */
export class AutoRange {
  private centerValue = 0;
  private halfRangeValue = 1;
  private seeded = false;

  /** Forget the tracked range, so the next observation snaps to it. */
  reset(): void {
    this.centerValue = 0;
    this.halfRangeValue = 1;
    this.seeded = false;
  }

  get center(): number {
    return this.centerValue;
  }

  get halfRange(): number {
    return this.halfRangeValue;
  }

  observe(extent: Extent | null): void {
    if (extent === null) {
      return;
    }
    const center = (extent.minimum + extent.maximum) / 2;
    const halfRange = Math.max((extent.maximum - extent.minimum) / 2, 1e-9);
    if (!this.seeded) {
      this.centerValue = center;
      this.halfRangeValue = halfRange;
      this.seeded = true;
      return;
    }
    // Contraction is gentle only to soften the step when a loud column ages out
    // of the window. It is no longer load-bearing: the extent it is fed already
    // describes the whole window, so there is nothing to ride out between peaks.
    const expanding = halfRange > this.halfRangeValue;
    this.halfRangeValue += (halfRange - this.halfRangeValue) * (expanding ? 1.0 : 0.2);
    this.centerValue += (center - this.centerValue) * (expanding ? 1.0 : 0.2);
  }
}
