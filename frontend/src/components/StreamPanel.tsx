import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

import { useStreamTap } from "../hooks/useStreamTap";
import { ScatterRenderer } from "../render/scatterRenderer";
import { TraceRenderer, channelColor } from "../render/traceRenderer";
import { channelAt, channelSelection, isSelectableAxis } from "../utils/channelSelection";
import type {
  StreamClientMode,
  StreamMode,
  StreamFrame,
  StreamInspect,
  StreamMeta,
  StreamTapAvailability,
} from "../types/stream";

type StreamPanelProps = {
  topic: string;
  unitAddress: string | null;
  darkMode: boolean;
  availability: StreamTapAvailability | null;
  /**
   * What profiling says the publisher is sending, in Hz.
   *
   * Used only to tell "nothing is being published" apart from "messages are
   * being published but this process cannot decode them" — see
   * {@link UNDECODABLE_HINT}. Without it the two look identical.
   */
  publisherRateHz: number | null;
  onClose: () => void;
};

/** How long to wait before deciding a silent tap is not just slow to start. */
const SILENT_TAP_GRACE_MS = 4000;

const UNDECODABLE_HINT =
  "The publisher is active but no messages are arriving here. ezmsg unpickles "
  + "messages in the subscribing process, so the dashboard can only read a topic "
  + "whose message class it can import — a type defined in a script's __main__, "
  + "or one from a package the dashboard's environment does not have, is dropped "
  + "before it reaches the viewer.";

/**
 * Whether a silent tap is better explained by an undecodable message type than
 * by an idle publisher.
 *
 * Exported for tests: the two conditions are easy to get backwards, and getting
 * them backwards means either accusing a healthy quiet topic of being broken or
 * staying silent about a topic that will never show anything.
 */
export function looksUndecodable(options: {
  messageCount: number | null;
  publisherRateHz: number | null;
  elapsedMs: number;
}): boolean {
  return (
    options.messageCount === 0
    && (options.publisherRateHz ?? 0) > 0
    && options.elapsedMs > SILENT_TAP_GRACE_MS
  );
}

/** Beyond this the gutter is unreadable and the labels are just noise. */
const MAX_LABELLED_CHANNELS = 48;
/** Minimum vertical room a label needs before it is worth drawing. */
const MIN_LABEL_ROW_PX = 11;
const FRAME_RATE_HZ = 30;
/** Columns cannot usefully exceed pixels; this also bounds the wire. */
const MAX_COLUMNS = 4096;
/** How long an overflow keeps its badge lit, so a brief gap is still noticed. */
const OVERFLOW_BADGE_MS = 2500;

/** Channel-window sizes offered when a stream has more channels than fit. */
const CHANNEL_PAGE_CHOICES = [8, 16, 32, 64, 128, 256, 512];
/**
 * Most lanes drawn at once, however wide the stream is.
 *
 * A ceiling on the *view*, not on the stream: a wider one is plotted a window at
 * a time and scrolled. Past this a lane is well under a pixel, so drawing more
 * adds nothing a person can read.
 */
const MAX_DRAWN_CHANNELS = 512;
/** Above this, showing every channel at once is a wall rather than a plot. */
const CHANNELS_SHOWN_BY_DEFAULT = 32;

/** Sweep window choices, in seconds. */
const WINDOW_CHOICES = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30];
const DEFAULT_WINDOW_SECONDS = 2;

/** Dock height bounds. The floor keeps the controls usable; the ceiling keeps
 *  the topology on screen. */
const DOCK_MIN_HEIGHT_PX = 180;
const DOCK_VIEWPORT_RESERVE_PX = 220;

function clampDockHeight(value: number): number {
  const ceiling = Math.max(
    DOCK_MIN_HEIGHT_PX,
    (typeof window === "undefined" ? 900 : window.innerHeight) - DOCK_VIEWPORT_RESERVE_PX
  );
  return Math.min(ceiling, Math.max(DOCK_MIN_HEIGHT_PX, Math.round(value)));
}

function formatRate(rateHz: number | null | undefined): string {
  if (rateHz === null || rateHz === undefined || !Number.isFinite(rateHz)) {
    return "—";
  }
  if (rateHz >= 1000) {
    return `${(rateHz / 1000).toFixed(1)} kHz`;
  }
  return `${rateHz.toFixed(rateHz < 10 ? 1 : 0)} Hz`;
}

function formatAmplitude(value: number, unit: string | null): string {
  const magnitude = Math.abs(value);
  let text: string;
  if (magnitude === 0) {
    text = "0";
  } else if (magnitude < 0.001 || magnitude >= 100000) {
    text = value.toExponential(1);
  } else {
    text = value.toPrecision(3);
  }
  return unit ? `${text} ${unit}` : text;
}

/** How much wall-clock the sweep window covers, for the x-axis caption. */
function windowCaption(
  meta: StreamMeta | null,
  mode: StreamMode | null,
  columns: number,
  windowSeconds: number,
  shownSeconds: number | null,
  samplesPerColumn: number | null
): string {
  if (!meta) {
    return "";
  }
  if (mode === "spectrum") {
    const span = (meta.n_bins ?? 0) * (meta.freq_gain ?? 0);
    return span > 0 ? `0 – ${span.toFixed(0)} Hz` : `${meta.n_bins ?? 0} bins`;
  }
  if (mode === "scatter") {
    return "channel map";
  }
  if (meta.srate > 0) {
    const span = shownSeconds ?? windowSeconds;
    // Reported by the backend rather than recomputed here: rounding a recomputed
    // ratio turned 1.31 into "1", which reads as no decimation at all.
    const perColumn = samplesPerColumn ?? (meta.srate * span) / columns;
    const perColumnText = perColumn >= 10 ? perColumn.toFixed(0) : perColumn.toFixed(2);
    const requested = Math.abs(span - windowSeconds) > 0.01 ? ` (asked ${windowSeconds}s)` : "";
    return `${Number(span.toFixed(2))}s${requested} · ${columns} columns · ${perColumnText} samples/column`;
  }
  // No sample rate, so the plot advances one column per message and seconds
  // would be a fiction.
  return `${columns} messages`;
}

function InspectorView({ inspect }: { inspect: StreamInspect | null }) {
  // The backend reports inspector state on a timer whether or not a message has
  // arrived, so an empty `type_name` means "nothing observed yet" rather than
  // "a type with no name". Rendering it would put a blank Type row under
  // whatever the caller already said about why nothing is arriving.
  if (!inspect || !inspect.type_name) {
    return null;
  }
  return (
    <div className="stream-inspect">
      <dl className="stream-inspect__grid">
        <dt>Type</dt>
        <dd>
          <code className="mono">{inspect.type_name}</code>
          <span className="stream-inspect__module">{inspect.module}</span>
        </dd>
        {inspect.dims ? (
          <>
            <dt>Dims</dt>
            <dd className="mono">
              {inspect.dims.map((dim, index) => `${dim}=${inspect.shape?.[index] ?? "?"}`).join(" × ")}
            </dd>
          </>
        ) : null}
        {inspect.dtype ? (
          <>
            <dt>Dtype</dt>
            <dd className="mono">{inspect.dtype}</dd>
          </>
        ) : null}
        {inspect.key ? (
          <>
            <dt>Key</dt>
            <dd className="mono">{inspect.key}</dd>
          </>
        ) : null}
      </dl>

      {inspect.axes && Object.keys(inspect.axes).length > 0 ? (
        <div className="stream-inspect__section">
          <h4>Axes</h4>
          <ul className="stream-inspect__list">
            {Object.entries(inspect.axes).map(([name, axis]) => (
              <li key={name}>
                <code className="mono">{name}</code>
                {axis.kind === "coord" ? (
                  <span>
                    coord · {axis.length} entries
                    {axis.fields ? ` · ${axis.fields.join(", ")}` : ""}
                    {axis.unit ? ` · ${axis.unit}` : ""}
                  </span>
                ) : (
                  <span>
                    linear · gain {axis.gain ?? "—"}
                    {axis.unit ? ` ${axis.unit}` : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {inspect.attrs && Object.keys(inspect.attrs).length > 0 ? (
        <div className="stream-inspect__section">
          <h4>Attrs</h4>
          <ul className="stream-inspect__list">
            {Object.entries(inspect.attrs).map(([name, value]) => (
              <li key={name}>
                <code className="mono">{name}</code>
                <span className="mono">{value}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {inspect.repr_preview ? (
        <div className="stream-inspect__section">
          <h4>Preview</h4>
          <pre className="stream-inspect__repr mono">{inspect.repr_preview}</pre>
        </div>
      ) : null}
    </div>
  );
}

export function StreamPanel({
  topic,
  unitAddress,
  darkMode,
  availability,
  publisherRateHz,
  onClose,
}: StreamPanelProps) {
  const [clientMode, setClientMode] = useState<StreamClientMode>("auto");
  const [gain, setGain] = useState(1);
  const [autoscale, setAutoscale] = useState(true);
  const [windowSeconds, setWindowSeconds] = useState(DEFAULT_WINDOW_SECONDS);
  const [channelOffset, setChannelOffset] = useState(0);
  const [visibleChannels, setVisibleChannels] = useState<number | null>(null);
  // Which folded axis is pinned, if any: `{axis, value}` picks one feature.
  const [pinnedAxis, setPinnedAxis] = useState<{ axis: number; value: number } | null>(null);
  // Null means "whatever the stream opened as"; a value overrides it.
  const [viewMode, setViewMode] = useState<StreamMode | null>(null);
  const [showInspector, setShowInspector] = useState(false);
  const [columns, setColumnsState] = useState(1200);
  const [plotHeightPx, setPlotHeightPx] = useState(0);
  // What the backend says the ring must be, which is not the pixel budget
  // whenever the stream is too slow to fill it.
  const [frameColumns, setFrameColumns] = useState<number | null>(null);
  const [shownSeconds, setShownSeconds] = useState<number | null>(null);
  const [samplesPerColumn, setSamplesPerColumn] = useState<number | null>(null);
  const [overflowAt, setOverflowAt] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [dockHeightPx, setDockHeightPx] = useState<number | null>(null);

  const plotHostRef = useRef<HTMLDivElement | null>(null);
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scatterCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const traceRef = useRef<TraceRenderer | null>(null);
  const scatterRef = useRef<ScatterRenderer | null>(null);

  // Frames arrive faster than React should re-render, so everything the frame
  // handler touches lives in refs and is sampled into state at human rates.
  const generationRef = useRef<number>(-1);
  const overflowRef = useRef(0);
  const modeRef = useRef<StreamMeta["mode"] | null>(null);
  const openedAtRef = useRef(performance.now());
  const frameColumnsRef = useRef<number | null>(null);
  // The frame handler runs outside React, so anything it needs about the current
  // channel selection has to reach it through a ref.
  const selectionRef = useRef({ offset: 0, stride: 1, total: 1 });
  const scatterValuesRef = useRef<Float32Array>(new Float32Array(0));
  const dockRef = useRef<HTMLElement | null>(null);
  const dockDragRef = useRef<{ pointerY: number; heightPx: number } | null>(null);

  const handleFrame = useCallback((frame: StreamFrame) => {
    const { header, payload } = frame;
    // A frame that names an older shape belongs to the previous plot; drawing
    // it would put the old stream's data on the new stream's axes.
    if (header.generation !== generationRef.current) {
      return;
    }
    if (header.overflow) {
      overflowRef.current = performance.now();
    }
    // Only ever changes when the window control moves, so promoting it to state
    // costs nothing at frame rate.
    if (header.columns !== undefined && header.columns !== frameColumnsRef.current) {
      frameColumnsRef.current = header.columns;
      setFrameColumns(header.columns);
      setShownSeconds(header.window_seconds ?? null);
      setSamplesPerColumn(header.samples_per_column ?? null);
    }
    if (header.mode === "scatter") {
      scatterRef.current?.push(payload, header.n_channels);
      return;
    }

    if (modeRef.current === "scatter") {
      // A map of a timeseries: the newest column is "now". Reading it out of the
      // sweep frames already in flight is what makes the view toggle instant --
      // it is a different reading of the same data, not a different stream.
      const selection = selectionRef.current;
      if (header.n_out > 0) {
        if (scatterValuesRef.current.length !== selection.total) {
          scatterValuesRef.current = new Float32Array(selection.total);
        }
        const values = scatterValuesRef.current;
        const lastColumn = (header.n_out - 1) * header.n_channels * header.components;
        for (let lane = 0; lane < selection.total; lane += 1) {
          const channel = selection.offset + lane * selection.stride;
          const base = lastColumn + channel * header.components;
          // Midpoint of the column's min/max: the column is a bucket, and its
          // centre is a fairer "current value" than either extreme.
          values[lane] =
            header.components >= 2 ? (payload[base] + payload[base + 1]) / 2 : payload[base];
        }
        scatterRef.current?.push(values, selection.total);
      }
      return;
    }

    traceRef.current?.push(payload, header.n_out);
  }, []);

  const { connectionState, meta, status, inspect, error, setColumns } = useStreamTap({
    topic,
    mode: clientMode,
    columns,
    windowSeconds,
    frameRateHz: FRAME_RATE_HZ,
    onFrame: handleFrame,
  });

  const availableModes = meta?.available_modes ?? (meta ? [meta.mode] : []);
  // The stream's own default unless the user picked one it actually supports;
  // a stale pick from a previous stream must not survive into this one.
  const plotMode =
    viewMode && availableModes.includes(viewMode) ? viewMode : (meta?.mode ?? null);
  modeRef.current = plotMode;
  const plottable = Boolean(meta) && inspect?.plottable !== false;
  // A renderer that failed to construct — no WebGL2, most likely — must take
  // the plot down with it. Leaving the canvas mounted would show a blank
  // rectangle and hide the explanation in the branch that never renders, which
  // is indistinguishable from a stream that is simply not sending anything.
  const showPlot =
    clientMode === "auto" && plottable && plotMode !== null && renderError === null;

  // -- renderer lifecycle ---------------------------------------------------

  useEffect(() => {
    if (!showPlot || plotMode === "scatter") {
      return undefined;
    }
    const canvas = glCanvasRef.current;
    if (!canvas) {
      return undefined;
    }
    try {
      traceRef.current = new TraceRenderer(canvas);
      setRenderError(null);
    } catch (creationError) {
      setRenderError(
        creationError instanceof Error ? creationError.message : String(creationError)
      );
      return undefined;
    }
    const renderer = traceRef.current;
    return () => {
      traceRef.current = null;
      renderer?.dispose();
    };
  }, [showPlot, plotMode === "scatter"]);

  useEffect(() => {
    if (!showPlot || plotMode !== "scatter") {
      return undefined;
    }
    const canvas = scatterCanvasRef.current;
    if (!canvas) {
      return undefined;
    }
    try {
      scatterRef.current = new ScatterRenderer(canvas);
      setRenderError(null);
    } catch (creationError) {
      setRenderError(
        creationError instanceof Error ? creationError.message : String(creationError)
      );
    }
    return () => {
      scatterRef.current = null;
    };
  }, [showPlot, plotMode]);

  // Reconfigure whenever the stream's shape changes. Keyed on the generation
  // the backend stamps, which is the one thing that says "this is a different
  // plot now" rather than "the same plot with new numbers".
  useEffect(() => {
    if (!meta || !showPlot) {
      return;
    }
    generationRef.current = meta.generation;
    // Configuring can fail on a stream this browser's WebGL cannot hold. It has
    // to be caught: an exception escaping an effect unmounts the whole panel, so
    // the user would lose the header, the inspector and the reason all at once.
    try {
      if (plotMode === "scatter") {
        scatterRef.current?.configure({
          positions: meta.channel_positions ?? [],
          // Positions are per entry of the position-bearing axis, and after a pin
          // the lanes run in that same order, so the labels line up lane for lane.
          labels: meta.channel_labels,
          darkMode,
        });
        return;
      }
      // Only sweep and spectrum reach here; the scatter branch returned above.
      const traceMode = plotMode === "spectrum" ? "spectrum" : "sweep";
      traceRef.current?.configure({
        mode: traceMode,
        nChannels: meta.n_channels,
        columns:
          traceMode === "spectrum"
            ? Math.max(2, meta.n_bins ?? 2)
            : (frameColumns ?? columns),
        components: traceMode === "spectrum" ? 1 : 2,
        darkMode,
      });
      setRenderError(null);
    } catch (configureError) {
      setRenderError(
        configureError instanceof Error ? configureError.message : String(configureError)
      );
    }
  }, [meta, showPlot, darkMode, columns, frameColumns, plotMode]);

  const totalChannels = meta?.n_channels ?? 0;
  const channelAxes = useMemo(() => meta?.channel_axes ?? [], [meta]);

  // Which channels the pinned axis (if any) leaves; falls back to all of them
  // when the pin is not expressible as a stride.
  const selection = useMemo(
    () =>
      channelSelection(
        channelAxes,
        totalChannels,
        pinnedAxis?.axis ?? null,
        pinnedAxis?.value ?? 0
      ) ?? { offset: 0, stride: 1, total: Math.max(1, totalChannels) },
    [channelAxes, totalChannels, pinnedAxis]
  );

  // Default to a readable slice rather than everything: a few hundred lanes in a
  // few hundred pixels is a solid block, not a plot.
  const drawnCeiling = Math.min(
    selection.total,
    availability?.max_drawn_channels ?? MAX_DRAWN_CHANNELS
  );
  const effectiveVisible = Math.max(
    1,
    Math.min(drawnCeiling, visibleChannels ?? Math.min(drawnCeiling, CHANNELS_SHOWN_BY_DEFAULT))
  );
  const maxChannelOffset = Math.max(0, selection.total - effectiveVisible);
  const windowOffset = Math.min(channelOffset, maxChannelOffset);
  const effectiveOffset = channelAt(selection, windowOffset);

  selectionRef.current = selection;

  useEffect(() => {
    traceRef.current?.setView({
      gain,
      autoscale,
      channelOffset: effectiveOffset,
      visibleChannels: effectiveVisible,
      channelStride: selection.stride,
    });
    scatterRef.current?.setView({ manualHalfRange: autoscale ? 0 : 1 / Math.max(1e-6, gain) });
  }, [gain, autoscale, meta, effectiveOffset, effectiveVisible, selection.stride]);

  // A new stream invalidates whatever slice was being looked at.
  useEffect(() => {
    setChannelOffset(0);
    setPinnedAxis(null);
    setViewMode(null);
    setVisibleChannels(null);
    frameColumnsRef.current = null;
    setFrameColumns(null);
    setShownSeconds(null);
    setSamplesPerColumn(null);
  }, [meta?.generation]);

  // -- sizing ---------------------------------------------------------------

  useEffect(() => {
    const host = plotHostRef.current;
    if (!host || !showPlot) {
      return undefined;
    }
    const applySize = () => {
      const rect = host.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      traceRef.current?.resize(rect.width, rect.height, ratio);
      scatterRef.current?.resize(rect.width, rect.height, ratio);
      // The column budget is the plot's pixel width: asking the backend for
      // more would spend wire on detail no pixel can show. It is additionally
      // capped by the renderer, where a column is a texture row.
      const rendererLimit = traceRef.current?.maxColumns ?? MAX_COLUMNS;
      const nextColumns = Math.max(
        64,
        Math.min(MAX_COLUMNS, rendererLimit, Math.round(rect.width))
      );
      setColumnsState(nextColumns);
      setColumns(nextColumns);
      setPlotHeightPx(rect.height);
    };
    applySize();
    const observer = new ResizeObserver(applySize);
    observer.observe(host);
    return () => observer.disconnect();
  }, [showPlot, plotMode, setColumns]);

  // -- render loop ----------------------------------------------------------

  useEffect(() => {
    if (!showPlot) {
      return undefined;
    }
    let handle = 0;
    const tick = () => {
      if (modeRef.current === "scatter") {
        scatterRef.current?.render();
      } else {
        traceRef.current?.render();
      }
      handle = window.requestAnimationFrame(tick);
    };
    handle = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(handle);
  }, [showPlot, plotMode]);

  // Sample the frame handler's refs at a rate a human can read.
  useEffect(() => {
    const interval = window.setInterval(() => {
      setOverflowAt((previous) =>
        overflowRef.current !== previous ? overflowRef.current : previous
      );
      setElapsedMs(performance.now() - openedAtRef.current);
    }, 400);
    return () => window.clearInterval(interval);
  }, []);

  const overflowActive = overflowAt > 0 && performance.now() - overflowAt < OVERFLOW_BADGE_MS;

  // A publisher that is demonstrably sending while the tap has received nothing
  // is the signature of a message class this process cannot import. Reporting it
  // matters because the alternative presentation -- an idle-looking panel -- is
  // exactly what a genuinely quiet topic looks like, and the two need very
  // different responses from whoever is looking.
  const undecodable =
    status !== null
    && looksUndecodable({
      messageCount: status.message_count,
      publisherRateHz,
      elapsedMs,
    });

  const labels = useMemo(() => {
    // Keyed on the view being drawn, not the stream's default: a sweep stream
    // shown as a map has no lanes for a gutter to label.
    if (!meta || plotMode === "scatter") {
      return null;
    }
    if (effectiveVisible > MAX_LABELLED_CHANNELS) {
      return null;
    }
    // A short dock with many channels puts the names closer together than they
    // are tall, which reads as a smear rather than as labels.
    if (plotHeightPx > 0 && plotHeightPx / effectiveVisible < MIN_LABEL_ROW_PX) {
      return null;
    }
    return Array.from({ length: effectiveVisible }, (_, lane) => {
      const channel = effectiveOffset + lane * selection.stride;
      return {
        channel,
        text: meta.channel_labels?.[channel] ?? `ch${channel}`,
      };
    });
  }, [meta, plotMode, plotHeightPx, effectiveVisible, effectiveOffset, selection.stride]);

  const range = traceRef.current?.getRange();
  const unavailableReason =
    availability && !availability.plotting ? availability.reason : null;

  const statusTone =
    error || status?.status === "error"
      ? "err"
      : status?.status === "live"
        ? "ok"
        : "warn";

  const handleDockResizeStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !dockRef.current) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dockDragRef.current = {
      pointerY: event.clientY,
      heightPx: dockRef.current.getBoundingClientRect().height,
    };
  };

  const handleDockResizeMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const origin = dockDragRef.current;
    if (!origin) {
      return;
    }
    // The dock is anchored to the bottom, so dragging up makes it taller.
    setDockHeightPx(clampDockHeight(origin.heightPx + (origin.pointerY - event.clientY)));
  };

  const handleDockResizeEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    dockDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleDockResizeKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === "ArrowUp" ? 32 : event.key === "ArrowDown" ? -32 : 0;
    if (step === 0 || !dockRef.current) {
      return;
    }
    event.preventDefault();
    setDockHeightPx(clampDockHeight(dockRef.current.getBoundingClientRect().height + step));
  };

  const dockStyle = (
    dockHeightPx === null ? undefined : { "--stream-dock-height": `${dockHeightPx}px` }
  ) as CSSProperties | undefined;

  return (
    <section className="stream-dock" ref={dockRef} style={dockStyle}>
      <button
        type="button"
        className="stream-dock__resize-handle"
        aria-label="Resize data viewer"
        onPointerDown={handleDockResizeStart}
        onPointerMove={handleDockResizeMove}
        onPointerUp={handleDockResizeEnd}
        onPointerCancel={handleDockResizeEnd}
        onKeyDown={handleDockResizeKeyDown}
      />
      <header className="stream-dock__header">
        <div className="stream-dock__title-wrap">
          <h3 className="mono">{topic}</h3>
          <p className="stream-dock__meta">
            {unitAddress ? <span className="mono">{unitAddress}</span> : null}
            {meta ? (
              <>
                <span>·</span>
                <span>{meta.mode}</span>
                <span>·</span>
                <span>
                  {meta.n_channels} ch
                  {meta.srate > 0 ? ` @ ${formatRate(meta.srate)}` : ""}
                </span>
              </>
            ) : null}
            <span>·</span>
            <span>{formatRate(status?.rate_hz)} msg</span>
            {meta?.unit ? (
              <>
                <span>·</span>
                <span>{meta.unit}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="stream-dock__actions">
          {overflowActive ? (
            <span
              className="stream-badge is-overflow"
              title="The viewer fell behind the publisher; samples were dropped and the trace has a real gap."
            >
              dropped
            </span>
          ) : null}
          <span className={`trace-status is-${statusTone}`}>
            {error ? "error" : (status?.status ?? connectionState)}
          </span>
          <button
            type="button"
            className={`topology-layout-btn ${showInspector ? "is-active" : ""}`.trim()}
            onClick={() => setShowInspector((previous) => !previous)}
            aria-pressed={showInspector}
            title="Show the raw message description"
          >
            Inspect
          </button>
          <button
            type="button"
            className="topology-layout-btn trace-dock__close-btn"
            onClick={onClose}
            title="Close stream viewer"
            aria-label="Close stream viewer"
          >
            ✕
          </button>
        </div>
      </header>

      <div className="stream-dock__body">
        <div className="stream-dock__plot-column">
          {showPlot ? (
            <>
              <div className={`stream-plot ${labels ? "is-labelled" : ""}`.trim()}>
                {labels ? (
                  <div className="stream-plot__labels" aria-hidden="true">
                    {labels.map((label, lane) => (
                      <span
                        key={label.channel}
                        className="stream-plot__label mono"
                        style={{
                          // Matches the shader's lane layout exactly, so a name
                          // always lines up with the trace it belongs to.
                          top: `${((2 * lane + 1) / (2 * labels.length)) * 100}%`,
                          // Keyed on the real channel, like the shader, so a
                          // trace keeps its colour while scrolling.
                          color: `rgb(${channelColor(label.channel)
                            .map((component) => Math.round(component * 255))
                            .join(",")})`,
                        }}
                      >
                        {label.text}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="stream-plot__host" ref={plotHostRef}>
                  <canvas
                    ref={glCanvasRef}
                    className="stream-plot__canvas"
                    hidden={plotMode === "scatter"}
                  />
                  <canvas
                    ref={scatterCanvasRef}
                    className="stream-plot__canvas"
                    hidden={plotMode !== "scatter"}
                  />
                </div>
              </div>
              <div className={`stream-plot__axis ${labels ? "is-labelled" : ""}`.trim()}>
                <span>{windowCaption(meta, plotMode, frameColumns ?? columns, windowSeconds, shownSeconds, samplesPerColumn)}</span>
                {range && plotMode !== "scatter" ? (
                  <span className="mono">
                    ± {formatAmplitude(range.halfRange, meta?.unit ?? null)}
                  </span>
                ) : null}
              </div>
            </>
          ) : (
            <div className="stream-panel__notice">
              {renderError ? (
                <p className="stream-panel__error">{renderError}</p>
              ) : unavailableReason ? (
                <p className="stream-panel__error">{unavailableReason}</p>
              ) : inspect?.plot_error ? (
                <p className="stream-panel__error">{inspect.plot_error}</p>
              ) : error ? (
                <p className="stream-panel__error">{error}</p>
              ) : undecodable ? (
                <p className="stream-panel__error">{UNDECODABLE_HINT}</p>
              ) : clientMode === "inspect" ? (
                <p className="stream-panel__empty">
                  Inspector only — no data is being streamed.
                </p>
              ) : (
                <p className="stream-panel__empty">Waiting for a message on this topic…</p>
              )}
              <InspectorView inspect={inspect} />
            </div>
          )}
        </div>

        <aside className="stream-dock__side">
          <div className="stream-controls">
            <label className="stream-control">
              <span>Mode</span>
              <select
                value={clientMode}
                onChange={(event) =>
                  setClientMode(event.target.value === "inspect" ? "inspect" : "auto")
                }
              >
                <option value="auto">Plot</option>
                <option value="inspect">Inspect only</option>
              </select>
            </label>
            {availableModes.length > 1 ? (
              <label className="stream-control">
                <span>View</span>
                <select
                  value={plotMode ?? ""}
                  onChange={(event) => setViewMode(event.target.value as StreamMode)}
                >
                  {availableModes.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode === "scatter" ? "channel map" : mode}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="stream-control">
              <span>Window</span>
              <select
                value={windowSeconds}
                onChange={(event) => setWindowSeconds(Number(event.target.value))}
                disabled={!meta || meta.srate <= 0 || plotMode === "scatter"}
                title={
                  meta && meta.srate <= 0
                    ? "This stream has no sample rate; the plot advances one column per message."
                    : "How many seconds of signal the plot shows"
                }
              >
                {WINDOW_CHOICES.map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {seconds < 1 ? `${seconds * 1000} ms` : `${seconds} s`}
                  </option>
                ))}
              </select>
            </label>
            {channelAxes.length > 1
              ? channelAxes.map((axis, axisIndex) =>
                  isSelectableAxis(channelAxes, axisIndex) && axis.size <= 64 ? (
                    <label className="stream-control" key={axis.name}>
                      <span>{axis.name}</span>
                      <select
                        value={pinnedAxis?.axis === axisIndex ? pinnedAxis.value : ""}
                        onChange={(event) => {
                          const raw = event.target.value;
                          setPinnedAxis(
                            raw === "" ? null : { axis: axisIndex, value: Number(raw) }
                          );
                          setChannelOffset(0);
                          setVisibleChannels(null);
                        }}
                      >
                        <option value="">all {axis.size}</option>
                        {Array.from({ length: axis.size }, (_, index) => (
                          <option key={index} value={index}>
                            {axis.labels?.[index] ?? `${axis.name}${index}`}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null
                )
              : null}
            {selection.total > 1 && plotMode !== "scatter" ? (
              <label className="stream-control">
                <span>
                  {selection.total === totalChannels ? "Channels" : "Selected"} {windowOffset}–
                  {windowOffset + effectiveVisible - 1} of {selection.total}
                </span>
                <select
                  value={effectiveVisible}
                  onChange={(event) => {
                    setVisibleChannels(Number(event.target.value));
                    setChannelOffset(0);
                  }}
                >
                  {CHANNEL_PAGE_CHOICES.filter((choice) => choice < drawnCeiling)
                    .concat(drawnCeiling)
                    .map((choice) => (
                    <option key={choice} value={choice}>
                      show {choice}
                    </option>
                  ))}
                </select>
                {maxChannelOffset > 0 ? (
                  <input
                    type="range"
                    min={0}
                    max={maxChannelOffset}
                    step={1}
                    value={effectiveOffset}
                    onChange={(event) => setChannelOffset(Number(event.target.value))}
                    aria-label="First channel shown"
                  />
                ) : null}
              </label>
            ) : null}
            <label className="stream-control stream-control--toggle">
              <input
                type="checkbox"
                checked={autoscale}
                onChange={(event) => setAutoscale(event.target.checked)}
              />
              <span>Autoscale</span>
            </label>
            <label className="stream-control">
              <span>Gain ×{gain.toFixed(2)}</span>
              <input
                type="range"
                min={-2}
                max={2}
                step={0.05}
                value={Math.log10(gain)}
                onChange={(event) =>
                  setGain(10 ** Number.parseFloat(event.target.value))
                }
              />
            </label>
            {status ? (
              <dl className="stream-controls__stats">
                <dt>Messages</dt>
                <dd className="mono">{status.message_count.toLocaleString()}</dd>
                <dt>Watchers</dt>
                <dd className="mono">{status.watchers}</dd>
                <dt>Columns</dt>
                <dd className="mono">{frameColumns ?? columns}</dd>
              </dl>
            ) : null}
            {status?.detail ? (
              <p className="stream-panel__error">{status.detail}</p>
            ) : null}
          </div>
          {showInspector && showPlot ? <InspectorView inspect={inspect} /> : null}
        </aside>
      </div>
    </section>
  );
}
