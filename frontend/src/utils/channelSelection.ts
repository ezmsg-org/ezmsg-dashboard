import type { ChannelAxis } from "../types/stream";

/**
 * Which flattened channels to draw when one folded axis is pinned to a value.
 *
 * A stream can fold several dimensions into "channels" — `(ch, feat)` is the
 * common one — and the backend reports them in the order the reshape uses. That
 * makes picking "just the second feature" an index problem, and which index
 * problem depends on the fold order:
 *
 * - `(ch, feat)` flattens to `ch * n_feat + feat`, so one feature is every
 *   `n_feat`-th channel — a stride.
 * - `(feat, ch)` flattens to `feat * n_ch + ch`, so one feature is a contiguous
 *   block — a stride of 1.
 *
 * Expressing both as `(offset, stride, total)` means the renderer needs one
 * mechanism rather than a special case per layout, and it is why this is worth
 * having as a pure function with tests: getting it wrong puts real data under
 * the wrong name, which is the failure this whole area already had once.
 */
export type ChannelSelection = {
  /** Flattened index of the first channel drawn. */
  offset: number;
  /** Spacing between consecutive drawn channels. */
  stride: number;
  /** How many channels the selection contains. */
  total: number;
};

/** Flattened-index step for advancing one entry along each axis. */
export function axisStrides(axes: ChannelAxis[]): number[] {
  const strides = new Array<number>(axes.length).fill(1);
  for (let index = axes.length - 2; index >= 0; index -= 1) {
    strides[index] = strides[index + 1] * axes[index + 1].size;
  }
  return strides;
}

/**
 * Whether pinning `axisIndex` leaves something a single stride can describe.
 *
 * Pinning one axis leaves the rest free, and a set with two or more free axes
 * of size > 1 is not an arithmetic progression — `(a, b, c)` with `b` pinned
 * interleaves two independent counters. Rather than draw something subtly wrong,
 * the control is not offered for those; the composite labels still are.
 */
export function isSelectableAxis(axes: ChannelAxis[], axisIndex: number): boolean {
  if (axisIndex < 0 || axisIndex >= axes.length || axes[axisIndex].size <= 1) {
    return false;
  }
  const freeAxes = axes.filter((axis, index) => index !== axisIndex && axis.size > 1);
  return freeAxes.length <= 1;
}

/**
 * The channels to draw, given an optional pinned axis.
 *
 * `null` for `axisIndex` means "everything", which is the whole flattened range.
 * Returns null when the pin cannot be expressed as a stride.
 */
export function channelSelection(
  axes: ChannelAxis[],
  totalChannels: number,
  axisIndex: number | null,
  value: number
): ChannelSelection | null {
  if (axisIndex === null || axes.length === 0) {
    return { offset: 0, stride: 1, total: Math.max(1, totalChannels) };
  }
  if (!isSelectableAxis(axes, axisIndex)) {
    return null;
  }
  const strides = axisStrides(axes);
  const pinned = Math.max(0, Math.min(axes[axisIndex].size - 1, value));
  const offset = pinned * strides[axisIndex];

  const freeIndex = axes.findIndex((axis, index) => index !== axisIndex && axis.size > 1);
  if (freeIndex === -1) {
    // Every other axis is a singleton, so the pin names exactly one channel.
    return { offset, stride: 1, total: 1 };
  }
  return { offset, stride: strides[freeIndex], total: axes[freeIndex].size };
}

/** Flattened index of the `lane`-th drawn channel. */
export function channelAt(selection: ChannelSelection, lane: number): number {
  return selection.offset + lane * selection.stride;
}
