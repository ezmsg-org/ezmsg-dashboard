/** Wire types for `/ws/stream`. Mirrors backend/services/stream_tap.py. */

/** What the stream turns out to be, decided by the backend from the data. */
export type StreamMode = "sweep" | "spectrum" | "scatter";

/** What a client may ask for. The stream still decides which view it supports. */
export type StreamClientMode = "auto" | "inspect";

/**
 * One dimension folded into the flattened channel axis.
 *
 * Reported in the order the backend's reshape folds them, which is what makes a
 * composite label line up with the trace it names.
 */
export type ChannelAxis = {
  name: string;
  size: number;
  /** One name per entry, or null when the axis carries no names. */
  labels: string[] | null;
};

export type StreamMeta = {
  /** The view the stream is opened as. */
  mode: StreamMode;
  /**
   * Every view this stream can be drawn as, default first.
   *
   * A `(time, ch)` stream with real electrode positions supports both `sweep`
   * and `scatter`; switching between them is a reading of the same frames, so it
   * happens in the browser without re-subscribing.
   */
  available_modes: StreamMode[];
  n_channels: number;
  /** Native per-sample tuple width: 2 when the stream is already a (min, max) envelope. */
  width: number;
  /** Samples per second, or 0 when the stream has no time axis to speak of. */
  srate: number;
  dims: string[];
  sample_dim: string;
  dtype: string;
  channel_labels: string[] | null;
  unit: string | null;
  metric_kind: string | null;
  key: string | null;
  complex_magnitude: boolean;
  channel_positions: Array<[number, number]> | null;
  /** The dimensions folded into `n_channels`, in fold order. */
  channel_axes: ChannelAxis[];
  /** Hz per bin, for the spectrum x axis. */
  freq_gain: number | null;
  n_bins: number | null;
  /** Bumped whenever the stream's shape changes; data frames name the one they belong to. */
  generation: number;
};

export type StreamStatus = {
  topic: string;
  status: "connecting" | "waiting" | "live" | "error";
  detail: string | null;
  message_count: number;
  rate_hz: number | null;
  seconds_since_last_message: number | null;
  watchers: number;
};

export type StreamAxisInfo =
  | { kind: "coord"; unit: string; length: number; fields: string[] | null }
  | { kind: "linear"; unit: string; gain: number | null; offset: number | null };

export type StreamInspect = {
  type_name: string;
  module: string;
  is_axisarray: boolean;
  dims: string[] | null;
  shape: number[] | null;
  dtype: string | null;
  key: string | null;
  axes: Record<string, StreamAxisInfo> | null;
  attrs: Record<string, string> | null;
  repr_preview: string | null;
  plottable: boolean;
  plot_error: string | null;
};

/** Header of a binary data frame; the float32 payload follows it. */
export type StreamFrameHeader = {
  kind: "stream.data";
  mode: StreamMode;
  generation: number;
  /** Columns (sweep) or rows (spectrum/scatter) in this payload. */
  n_out: number;
  n_channels: number;
  /** 2 for sweep min/max pairs, 1 otherwise. */
  components: number;
  /**
   * Sweep only: how wide the ring must be for the window to mean what it says.
   *
   * Not the plot's pixel width. A stream too slow to fill the pixel budget gets
   * fewer, wider columns instead — 2 s of a 100 Hz signal is 200 samples, and
   * stretching those across 2000 columns would silently show 20 s.
   */
  columns?: number;
  /** Sweep only: the span actually drawn, which is not always the one asked for. */
  window_seconds?: number | null;
  samples_per_column?: number;
  /** Sweep only: how many source samples this frame covers, before decimation. */
  n_samples?: number;
  first_sample_index?: number;
  t_start?: number | null;
  t_end?: number | null;
  /** True when the reader was lapped: there is a real gap before this frame. */
  overflow: boolean;
};

export type StreamFrame = {
  header: StreamFrameHeader;
  payload: Float32Array;
};

export type StreamTextEnvelope =
  | { kind: "stream.meta"; data: StreamMeta }
  | { kind: "stream.status"; data: StreamStatus }
  | { kind: "stream.inspect"; data: StreamInspect }
  | { kind: "stream.error"; data: { message: string } };

/** Advertised on `/api/health`, so the UI can gate on the optional extra. */
export type StreamTapAvailability = {
  inspector: boolean;
  plotting: boolean;
  reason: string | null;
  /** How many channels the viewer draws at once; wider streams scroll. */
  max_drawn_channels: number;
  max_columns: number;
  active_topics: string[];
};
