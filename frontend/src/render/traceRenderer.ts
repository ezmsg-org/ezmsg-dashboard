/**
 * A WebGL2 line renderer for stacked multichannel traces.
 *
 * The ring lives in a **texture**, not a vertex buffer, and every channel is
 * drawn by a single instanced call. Both of those are deliberate, and the first
 * one is not the obvious choice, so it is worth saying why.
 *
 * The obvious design puts y values in a vertex buffer with channels interleaved
 * and reads each channel out with a strided attribute. It is simple and it
 * works — up to 63 channels. `vertexAttribPointer` rejects a stride above 252
 * bytes, so a stride of `n_channels * 4` starts failing with `INVALID_VALUE`
 * somewhere past 63 channels and the plot silently goes blank. The failure mode
 * is nasty: uploads still succeed, draw calls still issue, and nothing appears.
 *
 * Sampling a texture in the vertex shader has no such limit. The ring is an
 * `RG32F` texture with one row per column and one texel per channel, red and
 * green holding that column's minimum and maximum. That is *exactly* the
 * `(n_out, n_channels, 2)` layout the backend already sends, so a frame is a
 * single `texSubImage2D` with no transpose and no per-sample work.
 *
 * Geometry comes entirely from `gl_VertexID` and `gl_InstanceID` — the channel
 * is the instance, so 8 channels and 512 channels both cost two draw calls per
 * frame rather than two per channel.
 *
 * Two modes share all of this:
 *
 * - `sweep` keeps a ring and overwrites the oldest column, CRT-style, with a
 *   blanking gap ahead of the write head so the eye can find "now".
 * - `spectrum` replaces the whole frame each time, so its ring is written from
 *   row zero every push.
 */

import { AutoRange, WindowExtent, laneWindowsEqual, scanColumnExtents } from "./autoRange";
import type { LaneWindow } from "./autoRange";

export type TraceMode = "sweep" | "spectrum";

export type TraceConfig = {
  mode: TraceMode;
  nChannels: number;
  /** Ring capacity in columns (sweep) or bins (spectrum). */
  columns: number;
  /** 2 for min/max envelope pairs, 1 for plain values. */
  components: number;
  darkMode: boolean;
};

export type TraceView = {
  /** Per-channel amplitude multiplier, applied on top of the auto range. */
  gain: number;
  autoscale: boolean;
  /** Used when `autoscale` is off: the half-range each channel is drawn against. */
  manualHalfRange: number;
  /**
   * First channel drawn, and how many.
   *
   * Windowing happens here rather than on the wire so that scrolling through
   * channels is immediate: the ring already holds every channel, and asking the
   * backend to re-subscribe would cost a round trip and a replot each time the
   * selection moved. The cost is that the wire still carries channels nobody is
   * looking at — worth revisiting if channel counts grow much past this.
   */
  channelOffset: number;
  visibleChannels: number;
  /**
   * Spacing between drawn channels, for picking one axis out of a folded stream.
   *
   * A `(ch, feat)` stream flattens to `ch * n_feat + feat`, so "just the second
   * feature" is every n_feat-th channel starting at 1 — a stride, not a range.
   * Folded the other way round it is a contiguous block, which is stride 1. One
   * mechanism covers both.
   */
  channelStride: number;
};

const DEFAULT_VIEW: TraceView = {
  gain: 1.0,
  autoscale: true,
  manualHalfRange: 1.0,
  channelOffset: 0,
  visibleChannels: 0,
  channelStride: 1,
};

/**
 * Columns blanked immediately ahead of the sweep cursor.
 *
 * Without a gap the newest column abuts the oldest and the plot reads as a
 * continuous trace with a step in it, which is exactly the misreading the
 * overflow reporting elsewhere exists to prevent.
 */
const SWEEP_GAP_COLUMNS = 6;

/** Distinguishable at a glance, and legible on both themes. */
const CHANNEL_PALETTE: Array<[number, number, number]> = [
  [0.26, 0.53, 0.96],
  [0.92, 0.44, 0.2],
  [0.24, 0.71, 0.44],
  [0.85, 0.31, 0.51],
  [0.55, 0.42, 0.89],
  [0.15, 0.68, 0.75],
  [0.87, 0.68, 0.18],
  [0.55, 0.58, 0.64],
];

const VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;

// The ring: one row per column, one texel per channel, .r = min, .g = max.
uniform sampler2D u_data;

uniform float u_columns;          // ring capacity, in columns
uniform int   u_verticesPerCol;   // 2 for min/max pairs, 1 otherwise
uniform int   u_channelOffset;    // first channel drawn
uniform int   u_channelStride;    // spacing between drawn channels
uniform int   u_visibleChannels;  // how many lanes the plot is divided into
uniform int   u_firstColumn;      // ring column this run starts at
uniform float u_center;           // data value drawn on a channel's midline
uniform float u_invHalfRange;     // data units -> [-1, 1]
uniform float u_bandFill;         // fraction of a channel's band the trace may use
uniform vec3  u_palette[8];

out vec3 v_color;

void main(void) {
    // The lane is the instance, so channel count costs nothing in draw calls.
    int lane = gl_InstanceID;
    int channel = u_channelOffset + lane * u_channelStride;
    int column = u_firstColumn + gl_VertexID / u_verticesPerCol;
    int which = gl_VertexID % u_verticesPerCol;

    vec2 pair = texelFetch(u_data, ivec2(channel, column), 0).rg;
    float value = (which == 1) ? pair.g : pair.r;

    float x = (float(column) / max(1.0, u_columns - 1.0)) * 2.0 - 1.0;
    // Clamping means an out-of-range sample flattens against its own band edge
    // instead of bleeding into the neighbouring channel's lane.
    float normalized = clamp((value - u_center) * u_invHalfRange, -1.0, 1.0);

    float lanes = float(u_visibleChannels);
    float bandHalf = (1.0 / lanes) * u_bandFill;
    float mid = 1.0 - (2.0 * float(lane) + 1.0) / lanes;

    gl_Position = vec4(x, mid + normalized * bandHalf, 0.0, 1.0);
    // Keyed on the real channel, so a trace keeps its colour while scrolling.
    v_color = u_palette[channel - (channel / 8) * 8];
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec3 v_color;
out vec4 outColor;

void main(void) {
    outColor = vec4(v_color, 1.0);
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("could not create shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compilation failed: ${log ?? "unknown"}`);
  }
  return shader;
}

export function channelColor(index: number): [number, number, number] {
  return CHANNEL_PALETTE[index % CHANNEL_PALETTE.length];
}

/**
 * The widest plot this renderer can hold, given the driver's texture limit.
 *
 * A column is a texture row, so the column budget is bounded by
 * `MAX_TEXTURE_SIZE` (8192 on current hardware, 2048 at the spec minimum).
 * Exposed so the panel can clamp its request rather than discovering the
 * ceiling as a failed allocation.
 */
export function maxColumnsFor(gl: WebGL2RenderingContext): number {
  return gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
}

export class TraceRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private texture: WebGLTexture | null = null;
  private readonly uniforms: Record<string, WebGLUniformLocation | null>;

  private config: TraceConfig = {
    mode: "sweep",
    nChannels: 1,
    columns: 2,
    components: 2,
    darkMode: false,
  };
  private view: TraceView = { ...DEFAULT_VIEW };

  /** Column the next push writes to, in ring coordinates. */
  private writeColumn = 0;
  /** How much of the ring has ever been written; bounds the draw before it fills. */
  private filledColumns = 0;

  private readonly autoRange = new AutoRange();
  private readonly windowExtent = new WindowExtent();
  // Scratch for one frame's per-column extents; grown, never reallocated per frame.
  private columnMinima = new Float32Array(0);
  private columnMaxima = new Float32Array(0);

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      // The plot is redrawn every frame from the ring, so nothing is gained by
      // preserving the previous contents and it costs a copy on some drivers.
      preserveDrawingBuffer: false,
      // No `desynchronized`. It trades compositing guarantees for a frame of
      // latency, which is a bad bargain for a plot that updates at 30 Hz and
      // whose data is already a decimated summary.
    });
    if (!gl) {
      throw new Error("WebGL2 is not available in this browser");
    }
    this.gl = gl;

    const program = gl.createProgram();
    if (!program) {
      throw new Error("could not create WebGL program");
    }
    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`program link failed: ${log ?? "unknown"}`);
    }
    this.program = program;

    // Geometry is generated from gl_VertexID and gl_InstanceID, so this VAO
    // deliberately has no attributes; it exists because a draw call needs one
    // bound.
    const vao = gl.createVertexArray();
    if (!vao) {
      throw new Error("could not allocate WebGL vertex array");
    }
    this.vao = vao;

    this.uniforms = {
      data: gl.getUniformLocation(program, "u_data"),
      columns: gl.getUniformLocation(program, "u_columns"),
      verticesPerCol: gl.getUniformLocation(program, "u_verticesPerCol"),
      channelOffset: gl.getUniformLocation(program, "u_channelOffset"),
      channelStride: gl.getUniformLocation(program, "u_channelStride"),
      visibleChannels: gl.getUniformLocation(program, "u_visibleChannels"),
      firstColumn: gl.getUniformLocation(program, "u_firstColumn"),
      center: gl.getUniformLocation(program, "u_center"),
      invHalfRange: gl.getUniformLocation(program, "u_invHalfRange"),
      bandFill: gl.getUniformLocation(program, "u_bandFill"),
      palette: gl.getUniformLocation(program, "u_palette[0]"),
    };
  }

  /** See {@link maxColumnsFor}: a column is a texture row. */
  get maxColumns(): number {
    return maxColumnsFor(this.gl);
  }

  private get verticesPerColumn(): number {
    return this.config.mode === "sweep" ? this.config.components : 1;
  }

  configure(config: TraceConfig): void {
    const gl = this.gl;
    const limit = this.maxColumns;
    // A channel is a texture column, so this is the one hard ceiling left. It is
    // 8192 on current hardware and 2048 at the spec minimum. Refusing loudly
    // matters more than it looks: clamping instead would draw a subset of the
    // stream under the whole stream's labels.
    if (config.nChannels > limit) {
      throw new Error(
        `stream has ${config.nChannels} channels; this browser's WebGL can hold `
        + `at most ${limit} in a plot buffer.`
      );
    }
    this.config = {
      ...config,
      columns: Math.max(2, Math.min(limit, config.columns)),
      nChannels: Math.max(1, config.nChannels),
    };
    this.writeColumn = 0;
    this.filledColumns = 0;
    this.autoRange.reset();
    this.windowExtent.configure(this.config.columns);

    if (this.texture) {
      gl.deleteTexture(this.texture);
    }
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    // texelFetch ignores filtering, but a float texture is not filterable
    // without an extension and some drivers complain about the default LINEAR
    // regardless, so set NEAREST explicitly.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(
      gl.TEXTURE_2D,
      1,
      this.config.components >= 2 ? gl.RG32F : gl.R32F,
      this.config.nChannels,
      this.config.columns
    );

    const palette = new Float32Array(CHANNEL_PALETTE.length * 3);
    CHANNEL_PALETTE.forEach((color, index) => palette.set(color, index * 3));
    gl.useProgram(this.program);
    gl.uniform3fv(this.uniforms.palette, palette);
    gl.uniform1i(this.uniforms.data, 0);
  }

  setView(view: Partial<TraceView>): void {
    const previousWindow = this.visibleRange();
    const previousAutoscale = this.view.autoscale;
    this.view = { ...this.view, ...view };

    // Changing which lanes are on screen changes what the scale is measured
    // from, often by orders of magnitude on a stream that mixes units. Keeping
    // the old range would leave the new selection flat against a rail for
    // seconds, because the tracker only contracts slowly.
    if (
      !laneWindowsEqual(previousWindow, this.visibleRange())
      || previousAutoscale !== this.view.autoscale
    ) {
      // The stored per-column extents describe lanes nobody is looking at any
      // more, so they go too -- reducing over them would scale the new
      // selection to the old one's amplitude.
      this.windowExtent.reset();
      this.autoRange.reset();
    }
  }

  /** The channel window actually in effect, clamped to what the stream has. */
  private visibleRange(): LaneWindow {
    const total = this.config.nChannels;
    const stride = Math.max(1, Math.round(this.view.channelStride));
    const available = Math.max(1, Math.ceil((total - Math.round(this.view.channelOffset)) / stride));
    const requested = this.view.visibleChannels > 0 ? this.view.visibleChannels : available;
    const count = Math.max(1, Math.min(available, requested));
    const offset = Math.max(0, Math.min(total - 1, Math.round(this.view.channelOffset)));
    return { offset, count, stride };
  }

  /**
   * Append `nOut` columns, wrapping the ring.
   *
   * `payload` must be `(n_out, n_channels, components)` float32 — the wire
   * layout — which is byte-identical to the texture rows it lands in, so it is
   * uploaded without being touched.
   */
  push(payload: Float32Array, nOut: number): void {
    const gl = this.gl;
    const { columns, nChannels, components } = this.config;
    if (nOut <= 0 || !this.texture) {
      return;
    }

    const floatsPerColumn = nChannels * components;
    let source = payload;
    let count = nOut;
    if (count > columns) {
      // More columns than the ring holds: only the tail can survive, and
      // uploading the rest would be writes nothing could ever read back.
      source = payload.subarray((count - columns) * floatsPerColumn);
      count = columns;
    }

    if (this.view.autoscale) {
      if (this.columnMinima.length < count) {
        this.columnMinima = new Float32Array(count);
        this.columnMaxima = new Float32Array(count);
      }
      // Only the lanes on screen, and kept per column so the scale can describe
      // the whole window rather than this one frame. See scanColumnExtents.
      scanColumnExtents(
        source,
        { columns: count, nChannels, components, window: this.visibleRange() },
        this.columnMinima,
        this.columnMaxima
      );
      if (this.config.mode === "spectrum") {
        this.windowExtent.replaceAll(this.columnMinima, this.columnMaxima, count);
      } else {
        this.windowExtent.writeColumns(
          this.writeColumn,
          this.columnMinima,
          this.columnMaxima,
          count
        );
      }
      this.autoRange.observe(this.windowExtent.extent());
    }

    const format = components >= 2 ? gl.RG : gl.RED;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    if (this.config.mode === "spectrum") {
      // A frame replaces the plot wholesale; there is no ring position to keep.
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0, nChannels, count, format, gl.FLOAT,
        source.subarray(0, count * floatsPerColumn)
      );
      this.filledColumns = count;
      this.writeColumn = 0;
      return;
    }

    const firstRun = Math.min(count, columns - this.writeColumn);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, this.writeColumn, nChannels, firstRun, format, gl.FLOAT,
      source.subarray(0, firstRun * floatsPerColumn)
    );
    if (firstRun < count) {
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0, nChannels, count - firstRun, format, gl.FLOAT,
        source.subarray(firstRun * floatsPerColumn, count * floatsPerColumn)
      );
    }
    this.writeColumn = (this.writeColumn + count) % columns;
    this.filledColumns = Math.min(columns, this.filledColumns + count);
  }

  /**
   * The data range currently being drawn against, for the axis readout.
   *
   * Returned rather than recomputed by the caller because autoscale makes it
   * stateful: what the plot is scaled to is not derivable from the last frame.
   */
  getRange(): { center: number; halfRange: number } {
    return { center: this.autoRange.center, halfRange: this.effectiveHalfRange() };
  }

  private effectiveHalfRange(): number {
    const base = this.view.autoscale ? this.autoRange.halfRange : this.view.manualHalfRange;
    return Math.max(1e-12, base / Math.max(1e-6, this.view.gain));
  }

  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    const canvas = this.gl.canvas as HTMLCanvasElement;
    const width = Math.max(1, Math.round(cssWidth * devicePixelRatio));
    const height = Math.max(1, Math.round(cssHeight * devicePixelRatio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    this.gl.viewport(0, 0, width, height);
  }

  render(): void {
    const gl = this.gl;
    const { columns, darkMode } = this.config;

    if (darkMode) {
      gl.clearColor(0.09, 0.1, 0.12, 1.0);
    } else {
      gl.clearColor(1.0, 1.0, 1.0, 1.0);
    }
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.filledColumns === 0 || !this.texture) {
      return;
    }

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    const verticesPerColumn = this.verticesPerColumn;
    const { offset, count, stride } = this.visibleRange();
    gl.uniform1f(this.uniforms.columns, columns);
    gl.uniform1i(this.uniforms.verticesPerCol, verticesPerColumn);
    gl.uniform1i(this.uniforms.channelOffset, offset);
    gl.uniform1i(this.uniforms.channelStride, stride);
    gl.uniform1i(this.uniforms.visibleChannels, count);
    gl.uniform1f(this.uniforms.center, this.autoRange.center);
    gl.uniform1f(this.uniforms.invHalfRange, 1 / this.effectiveHalfRange());
    // Leave a sliver between neighbouring lanes so a clipped trace does not read
    // as belonging to the channel below it. Dense plots get a thinner lane so
    // the gaps stay visible at one or two pixels per channel.
    gl.uniform1f(this.uniforms.bandFill, count > 64 ? 0.8 : 0.9);

    for (const [firstColumn, columnCount] of this.segments()) {
      if (columnCount <= 0) {
        continue;
      }
      gl.uniform1i(this.uniforms.firstColumn, firstColumn);
      gl.drawArraysInstanced(gl.LINE_STRIP, 0, columnCount * verticesPerColumn, count);
    }

    gl.bindVertexArray(null);
  }

  /**
   * Column runs to draw, as `[firstColumn, count]`.
   *
   * A sweep is two runs, not one: the ring's newest column and its oldest are
   * adjacent in memory but a whole window apart in time, and a single strip
   * across that seam would draw a line joining them. The gap ahead of the write
   * head is dropped from the older run for the same reason.
   */
  private segments(): Array<[number, number]> {
    const { columns, mode } = this.config;
    if (mode === "spectrum" || this.filledColumns < columns) {
      // Not yet wrapped: everything written so far is one contiguous run.
      return [[0, this.filledColumns]];
    }
    const gap = Math.min(SWEEP_GAP_COLUMNS, columns - 1);
    // No wraparound arithmetic needed: when the head is near the right edge the
    // older run's count simply goes non-positive and is skipped.
    return [
      [0, this.writeColumn],
      [this.writeColumn + gap, Math.max(0, columns - this.writeColumn - gap)],
    ];
  }

  dispose(): void {
    const gl = this.gl;
    if (this.texture) {
      gl.deleteTexture(this.texture);
      this.texture = null;
    }
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
