import { useEffect, useMemo, useRef, useState } from "react";
import { leaseColorForEndpoint } from "../utils/traceColors";

export type TimingTraceSample = {
  timestamp: number;
  processId: string;
  endpointId: string;
  topic: string;
  metric: string;
  value: number;
  sampleSeq: number | null;
};

type TraceTimingPanelProps = {
  samples: TimingTraceSample[];
  publisherProcessId: string;
  publisherEndpointId: string;
  topic: string;
  topicScope?: string[];
  leaseColorMap?: Record<string, string>;
  windowSeconds: number;
  onWindowSecondsChange?: (seconds: number) => void;
};

type PlotLayout = {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  plotWidth: number;
  plotHeight: number;
  plotTop: number;
  plotBottom: number;
  cols: number;
  xTicks: number;
  yTicks: number;
};

type RendererState = {
  layout: PlotLayout;
  windowNs: number;
  scopeSignature: string;
  publisherSignature: string;
  originNs: number | null;
  lastTimestamp: number;
  lastCursorCol: number | null;
  lastSampleKey: string | null;
  yMaxMs: number;
  columnCycle: Int32Array;
  publishBins: Float32Array;
  attrBins: Float32Array;
  leaseBinsByEndpoint: Map<string, Float32Array>;
};

const BG_COLOR = "#0f172a";
const GRID_COLOR = "#1e293b";
const AXIS_COLOR = "#334155";
const LABEL_COLOR = "#cbd5e1";
const PUBLISH_COLOR = "#38bdf8";
const ATTR_BP_COLOR = "#f59e0b";
const CURSOR_COLOR = "#fbbf24";
const MIN_Y_MAX_MS = 0.25;
const DEFAULT_MANUAL_Y_MAX_MS = 5.0;
const AUTO_Y_HEADROOM = 1.1;
const AUTO_Y_DECAY = 0.97;

function toMs(valueNs: number): number {
  return valueNs / 1_000_000;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function parsePositiveFloat(value: string): number | null {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function makeLayout(canvas: HTMLCanvasElement, windowSeconds: number): PlotLayout {
  const width = Math.max(440, Math.floor(canvas.clientWidth));
  const height = 220;
  const left = 52;
  const right = 16;
  const top = 12;
  const bottom = 24;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  return {
    width,
    height,
    left,
    right,
    top,
    bottom,
    plotWidth,
    plotHeight,
    plotTop: top + 2,
    plotBottom: top + plotHeight - 2,
    cols: Math.max(1, Math.floor(plotWidth)),
    xTicks: Math.max(2, Math.floor(windowSeconds / 0.5)),
    yTicks: 4,
  };
}

function makeNaNBins(cols: number): Float32Array {
  const bins = new Float32Array(cols);
  bins.fill(Number.NaN);
  return bins;
}

function makeRendererState(
  layout: PlotLayout,
  windowNs: number,
  scopeSignature: string,
  publisherSignature: string,
  yMaxMs: number
): RendererState {
  const cycle = new Int32Array(layout.cols);
  cycle.fill(-2147483648);
  return {
    layout,
    windowNs,
    scopeSignature,
    publisherSignature,
    originNs: null,
    lastTimestamp: 0,
    lastCursorCol: null,
    lastSampleKey: null,
    yMaxMs,
    columnCycle: cycle,
    publishBins: makeNaNBins(layout.cols),
    attrBins: makeNaNBins(layout.cols),
    leaseBinsByEndpoint: new Map<string, Float32Array>(),
  };
}

function sampleKey(sample: TimingTraceSample): string {
  return [
    sample.timestamp,
    sample.metric,
    sample.endpointId,
    sample.sampleSeq ?? "",
    sample.value,
  ].join("|");
}

function matchesTopicScope(sampleTopic: string, topicScope: string[]): boolean {
  for (const topic of topicScope) {
    if (sampleTopic === topic || sampleTopic.startsWith(`${topic}:`)) {
      return true;
    }
  }
  return false;
}

function colForTimestamp(
  timestamp: number,
  origin: number,
  windowNs: number,
  cols: number
): { col: number; cycle: number } {
  const delta = timestamp - origin;
  const cycle = Math.floor(delta / windowNs);
  const wrapped = ((delta % windowNs) + windowNs) % windowNs;
  const col = clamp(Math.floor((wrapped / windowNs) * cols), 0, cols - 1);
  return { col, cycle };
}

function yFromMs(valueMs: number, yMaxMs: number, layout: PlotLayout): number {
  const ratio = clamp(valueMs / Math.max(yMaxMs, 1e-9), 0, 1);
  return layout.plotBottom - ratio * (layout.plotBottom - layout.plotTop);
}

function clearRange(
  context: CanvasRenderingContext2D,
  layout: PlotLayout,
  startCol: number,
  endCol: number
): void {
  const start = clamp(startCol, 0, layout.cols - 1);
  const end = clamp(endCol, 0, layout.cols - 1);
  if (end < start) {
    return;
  }
  const x0 = layout.left + start;
  const width = end - start + 1;
  context.fillStyle = BG_COLOR;
  context.fillRect(x0, layout.top, width, layout.plotHeight);

  context.strokeStyle = GRID_COLOR;
  context.lineWidth = 1;
  for (let i = 0; i <= layout.xTicks; i += 1) {
    const x = layout.left + (i / layout.xTicks) * layout.plotWidth;
    if (x < x0 - 1 || x > x0 + width + 1) {
      continue;
    }
    context.beginPath();
    context.moveTo(x, layout.top);
    context.lineTo(x, layout.top + layout.plotHeight);
    context.stroke();
  }
  for (let i = 0; i <= layout.yTicks; i += 1) {
    const y =
      layout.plotBottom - (i / layout.yTicks) * (layout.plotBottom - layout.plotTop);
    context.beginPath();
    context.moveTo(x0, y);
    context.lineTo(x0 + width, y);
    context.stroke();
  }
  context.strokeStyle = AXIS_COLOR;
  context.beginPath();
  context.moveTo(x0, layout.plotBottom);
  context.lineTo(x0 + width, layout.plotBottom);
  context.stroke();
}

function drawLineRange(
  context: CanvasRenderingContext2D,
  bins: Float32Array,
  {
    color,
    lineWidth,
    startCol,
    endCol,
    yMaxMs,
    layout,
  }: {
    color: string;
    lineWidth: number;
    startCol: number;
    endCol: number;
    yMaxMs: number;
    layout: PlotLayout;
  }
): void {
  const from = Math.max(0, startCol - 1);
  const to = Math.min(layout.cols - 1, endCol + 1);
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.beginPath();
  let started = false;
  for (let col = from; col <= to; col += 1) {
    const valueMs = bins[col];
    if (!Number.isFinite(valueMs) || valueMs > yMaxMs) {
      if (started) {
        context.stroke();
        context.beginPath();
        started = false;
      }
      continue;
    }
    const x = layout.left + col + 0.5;
    const y = yFromMs(valueMs, yMaxMs, layout);
    if (!started) {
      context.moveTo(x, y);
      started = true;
    } else {
      context.lineTo(x, y);
    }
  }
  if (started) {
    context.stroke();
  }
}

function drawAttrRange(
  context: CanvasRenderingContext2D,
  bins: Float32Array,
  {
    startCol,
    endCol,
    yMaxMs,
    layout,
  }: {
    startCol: number;
    endCol: number;
    yMaxMs: number;
    layout: PlotLayout;
  }
): void {
  context.strokeStyle = ATTR_BP_COLOR;
  context.lineWidth = 1;
  context.globalAlpha = 0.5;
  for (let col = startCol; col <= endCol; col += 1) {
    const valueMs = bins[col];
    if (!Number.isFinite(valueMs) || valueMs > yMaxMs) {
      continue;
    }
    const x = layout.left + col + 0.5;
    const y = yFromMs(valueMs, yMaxMs, layout);
    context.beginPath();
    context.moveTo(x, layout.plotBottom);
    context.lineTo(x, y);
    context.stroke();
  }
  context.globalAlpha = 1;
}

function drawRange(
  context: CanvasRenderingContext2D,
  state: RendererState,
  startCol: number,
  endCol: number,
  leaseColorMap?: Record<string, string>
): void {
  clearRange(context, state.layout, startCol, endCol);
  drawAttrRange(context, state.attrBins, {
    startCol,
    endCol,
    yMaxMs: state.yMaxMs,
    layout: state.layout,
  });
  for (const [endpointId, bins] of state.leaseBinsByEndpoint.entries()) {
    drawLineRange(context, bins, {
      color: leaseColorForEndpoint(endpointId, leaseColorMap),
      lineWidth: 1.1,
      startCol,
      endCol,
      yMaxMs: state.yMaxMs,
      layout: state.layout,
    });
  }
  drawLineRange(context, state.publishBins, {
    color: PUBLISH_COLOR,
    lineWidth: 1.25,
    startCol,
    endCol,
    yMaxMs: state.yMaxMs,
    layout: state.layout,
  });
}

function drawLabelsAndCursor(
  context: CanvasRenderingContext2D,
  state: RendererState,
  windowSeconds: number
): void {
  const { layout } = state;
  context.fillStyle = BG_COLOR;
  context.fillRect(0, 0, layout.left - 2, layout.height);
  context.fillRect(layout.left, layout.plotBottom + 1, layout.plotWidth, layout.bottom + 6);

  if (state.lastCursorCol !== null) {
    const x = layout.left + state.lastCursorCol + 0.5;
    context.strokeStyle = CURSOR_COLOR;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(x, layout.top);
    context.lineTo(x, layout.top + layout.plotHeight);
    context.stroke();
  }

  context.fillStyle = LABEL_COLOR;
  context.font = '11px "Avenir Next", sans-serif';
  context.fillText(
    `${windowSeconds.toFixed(1)}s`,
    layout.left + layout.plotWidth - 24,
    layout.top + layout.plotHeight + 16
  );
  context.fillText(`${state.yMaxMs.toFixed(2)} ms`, 6, layout.plotTop + 8);
  context.fillText("0 ms", 8, layout.plotBottom + 4);
}

function addTraversedColumns(
  changed: Set<number>,
  fromCol: number,
  toCol: number,
  cols: number
): void {
  if (toCol >= fromCol) {
    for (let col = fromCol; col <= toCol; col += 1) {
      changed.add(col);
    }
    return;
  }
  for (let col = fromCol; col < cols; col += 1) {
    changed.add(col);
  }
  for (let col = 0; col <= toCol; col += 1) {
    changed.add(col);
  }
}

function columnRanges(changed: Set<number>): Array<{ start: number; end: number }> {
  const sorted = Array.from(changed).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return [];
  }
  const ranges: Array<{ start: number; end: number }> = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    const col = sorted[i];
    if (col === end + 1) {
      end = col;
      continue;
    }
    ranges.push({ start, end });
    start = col;
    end = col;
  }
  ranges.push({ start, end });
  return ranges;
}

export function TraceTimingPanel({
  samples,
  publisherProcessId,
  publisherEndpointId,
  topic,
  topicScope,
  leaseColorMap,
  windowSeconds,
  onWindowSecondsChange,
}: TraceTimingPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<RendererState | null>(null);
  const autoYMaxMsRef = useRef<number | null>(null);
  const [autoYAxis, setAutoYAxis] = useState(true);
  const [manualYMaxInput, setManualYMaxInput] = useState(
    `${DEFAULT_MANUAL_Y_MAX_MS.toFixed(2)}`
  );

  const manualYMaxMs = useMemo(
    () => parsePositiveFloat(manualYMaxInput),
    [manualYMaxInput]
  );

  const effectiveTopicScope = useMemo(
    () => (topicScope && topicScope.length > 0 ? topicScope : [topic]),
    [topic, topicScope]
  );
  const scopeSignature = useMemo(
    () => [...effectiveTopicScope].sort().join("|"),
    [effectiveTopicScope]
  );
  const publisherSignature = `${publisherProcessId}|${publisherEndpointId}`;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const layout = makeLayout(canvas, windowSeconds);
    canvas.width = Math.floor(layout.width * devicePixelRatio);
    canvas.height = Math.floor(layout.height * devicePixelRatio);
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

    const windowNs = Math.max(1, windowSeconds * 1_000_000_000);
    const desiredY = autoYAxis
      ? Math.max(MIN_Y_MAX_MS, autoYMaxMsRef.current ?? MIN_Y_MAX_MS)
      : Math.max(MIN_Y_MAX_MS, manualYMaxMs ?? DEFAULT_MANUAL_Y_MAX_MS);

    let renderer = rendererRef.current;
    const needsReinit =
      renderer === null
      || renderer.layout.cols !== layout.cols
      || renderer.layout.width !== layout.width
      || renderer.windowNs !== windowNs
      || renderer.scopeSignature !== scopeSignature
      || renderer.publisherSignature !== publisherSignature;
    if (needsReinit) {
      renderer = makeRendererState(
        layout,
        windowNs,
        scopeSignature,
        publisherSignature,
        desiredY
      );
      rendererRef.current = renderer;
      autoYMaxMsRef.current = desiredY;
      context.fillStyle = BG_COLOR;
      context.fillRect(0, 0, layout.width, layout.height);
    }

    if (renderer === null) {
      return;
    }

    const changedCols = new Set<number>();
    let batchMaxMs = MIN_Y_MAX_MS;
    let newestTimestamp = renderer.lastTimestamp;
    let processedAny = false;
    let forceFullRedraw = needsReinit;

    const lastKey = renderer.lastSampleKey;
    let startIndex = 0;
    if (lastKey !== null && samples.length > 0) {
      let foundIndex = -1;
      for (let idx = samples.length - 1; idx >= 0; idx -= 1) {
        if (sampleKey(samples[idx]) === lastKey) {
          foundIndex = idx;
          break;
        }
      }
      if (foundIndex >= 0) {
        startIndex = foundIndex + 1;
      } else {
        renderer.publishBins.fill(Number.NaN);
        renderer.attrBins.fill(Number.NaN);
        renderer.columnCycle.fill(-2147483648);
        for (const leaseBins of renderer.leaseBinsByEndpoint.values()) {
          leaseBins.fill(Number.NaN);
        }
        renderer.originNs = null;
        renderer.lastTimestamp = 0;
        renderer.lastCursorCol = null;
        forceFullRedraw = true;
        startIndex = 0;
      }
    }

    const incoming = samples.slice(startIndex);
    if (incoming.length > 0) {
      renderer.lastSampleKey = sampleKey(incoming[incoming.length - 1]);
    }

    for (const sample of incoming) {
      if (
        !Number.isFinite(sample.timestamp)
        || !Number.isFinite(sample.value)
        || !matchesTopicScope(sample.topic, effectiveTopicScope)
      ) {
        continue;
      }
      const isPublisherMetric =
        sample.metric === "publish_delta_ns"
        && sample.processId === publisherProcessId
        && sample.endpointId === publisherEndpointId;
      const isAttrMetric = sample.metric === "attributable_backpressure_ns";
      const isLeaseMetric = sample.metric === "lease_time_ns";
      if (!isPublisherMetric && !isAttrMetric && !isLeaseMetric) {
        continue;
      }

      if (renderer.originNs === null) {
        renderer.originNs = sample.timestamp;
      }
      if (renderer.originNs === null || sample.timestamp < renderer.originNs) {
        continue;
      }

      const { col, cycle } = colForTimestamp(
        sample.timestamp,
        renderer.originNs,
        renderer.windowNs,
        renderer.layout.cols
      );
      if (cycle > renderer.columnCycle[col]) {
        renderer.publishBins[col] = Number.NaN;
        renderer.attrBins[col] = Number.NaN;
        for (const leaseBins of renderer.leaseBinsByEndpoint.values()) {
          leaseBins[col] = Number.NaN;
        }
        renderer.columnCycle[col] = cycle;
        changedCols.add(col);
      }

      const valueMs = toMs(sample.value);
      if (!Number.isFinite(valueMs) || valueMs < 0) {
        continue;
      }

      if (isPublisherMetric) {
        const current = renderer.publishBins[col];
        if (!Number.isFinite(current) || valueMs > current) {
          renderer.publishBins[col] = valueMs;
          changedCols.add(col);
        }
      } else if (isAttrMetric) {
        const current = renderer.attrBins[col];
        if (!Number.isFinite(current) || valueMs > current) {
          renderer.attrBins[col] = valueMs;
          changedCols.add(col);
        }
      } else {
        let leaseBins = renderer.leaseBinsByEndpoint.get(sample.endpointId);
        if (!leaseBins) {
          leaseBins = makeNaNBins(renderer.layout.cols);
          renderer.leaseBinsByEndpoint.set(sample.endpointId, leaseBins);
        }
        const current = leaseBins[col];
        if (!Number.isFinite(current) || valueMs > current) {
          leaseBins[col] = valueMs;
          changedCols.add(col);
        }
      }

      batchMaxMs = Math.max(batchMaxMs, valueMs);
      newestTimestamp = Math.max(newestTimestamp, sample.timestamp);
      processedAny = true;
    }

    let nextYMaxMs = renderer.yMaxMs;
    if (autoYAxis) {
      const target = Math.max(MIN_Y_MAX_MS, batchMaxMs * AUTO_Y_HEADROOM);
      const previous = autoYMaxMsRef.current;
      if (previous === null || target >= previous) {
        nextYMaxMs = target;
      } else {
        nextYMaxMs = Math.max(target, previous * AUTO_Y_DECAY);
      }
      autoYMaxMsRef.current = nextYMaxMs;
    } else {
      nextYMaxMs = Math.max(MIN_Y_MAX_MS, manualYMaxMs ?? DEFAULT_MANUAL_Y_MAX_MS);
      autoYMaxMsRef.current = nextYMaxMs;
    }
    if (Math.abs(nextYMaxMs - renderer.yMaxMs) > 1e-9) {
      renderer.yMaxMs = nextYMaxMs;
      forceFullRedraw = true;
    }

    if (processedAny && renderer.originNs !== null) {
      const latest = colForTimestamp(
        newestTimestamp,
        renderer.originNs,
        renderer.windowNs,
        renderer.layout.cols
      );
      if (
        renderer.lastCursorCol !== null
        && newestTimestamp - renderer.lastTimestamp >= renderer.windowNs
      ) {
        forceFullRedraw = true;
      } else if (renderer.lastCursorCol !== null) {
        addTraversedColumns(
          changedCols,
          renderer.lastCursorCol,
          latest.col,
          renderer.layout.cols
        );
      } else {
        changedCols.add(latest.col);
      }
      if (renderer.lastCursorCol !== null) {
        changedCols.add(renderer.lastCursorCol);
      }
      renderer.lastCursorCol = latest.col;
      renderer.lastTimestamp = newestTimestamp;
    }

    if (forceFullRedraw) {
      context.fillStyle = BG_COLOR;
      context.fillRect(0, 0, renderer.layout.width, renderer.layout.height);
      drawRange(context, renderer, 0, renderer.layout.cols - 1, leaseColorMap);
    } else if (changedCols.size > 0) {
      for (const range of columnRanges(changedCols)) {
        drawRange(context, renderer, range.start, range.end, leaseColorMap);
      }
    }

    if (renderer.lastTimestamp <= 0) {
      context.fillStyle = BG_COLOR;
      context.fillRect(0, 0, renderer.layout.width, renderer.layout.height);
      context.fillStyle = "#94a3b8";
      context.font = '12px "Avenir Next", sans-serif';
      context.fillText("Waiting for trace samples...", renderer.layout.left, 26);
      drawLabelsAndCursor(context, renderer, windowSeconds);
      return;
    }

    drawLabelsAndCursor(context, renderer, windowSeconds);
  }, [
    autoYAxis,
    effectiveTopicScope,
    leaseColorMap,
    manualYMaxMs,
    publisherEndpointId,
    publisherProcessId,
    publisherSignature,
    samples,
    scopeSignature,
    windowSeconds,
  ]);

  return (
    <div className="timing-trace">
      <div className="timing-trace__controls">
        <label className="timing-trace__axis-input">
          <span>Window (s)</span>
          <input
            type="number"
            min={0.5}
            max={30}
            step="0.5"
            value={windowSeconds.toFixed(1)}
            onChange={(event) => {
              const parsed = parsePositiveFloat(event.target.value);
              if (parsed === null || !onWindowSecondsChange) {
                return;
              }
              onWindowSecondsChange(clamp(parsed, 0.5, 30));
            }}
          />
        </label>
        <button
          type="button"
          className={`timing-trace__axis-btn ${autoYAxis ? "is-active" : ""}`}
          onClick={() => setAutoYAxis(true)}
        >
          Auto Y
        </button>
        <button
          type="button"
          className={`timing-trace__axis-btn ${autoYAxis ? "" : "is-active"}`}
          onClick={() => setAutoYAxis(false)}
        >
          Fixed Y
        </button>
        <label className="timing-trace__axis-input">
          <span>Y max (ms)</span>
          <input
            type="number"
            min={MIN_Y_MAX_MS}
            step="0.1"
            value={manualYMaxInput}
            onChange={(event) => setManualYMaxInput(event.target.value)}
            onBlur={() => {
              const parsed = parsePositiveFloat(manualYMaxInput);
              if (parsed === null) {
                setManualYMaxInput(`${DEFAULT_MANUAL_Y_MAX_MS.toFixed(2)}`);
                return;
              }
              const clamped = Math.max(MIN_Y_MAX_MS, parsed);
              setManualYMaxInput(clamped.toFixed(2));
            }}
            disabled={autoYAxis}
          />
        </label>
      </div>
      <canvas ref={canvasRef} className="timing-trace__canvas" />
      <div className="timing-trace__legend">
        <span className="timing-trace__legend-item">
          <i style={{ background: PUBLISH_COLOR }} />
          Publish Delta
        </span>
        <span className="timing-trace__legend-item">
          <i style={{ background: ATTR_BP_COLOR }} />
          Attr BP (all subs)
        </span>
      </div>
    </div>
  );
}
