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
  nominalPublishRateHz: number;
  topic: string;
  topicScope?: string[];
  leaseColorMap?: Record<string, string>;
  selectedSubscriberEndpointId?: string | null;
  windowSeconds: number;
  onWindowSecondsChange?: (seconds: number) => void;
  darkMode?: boolean;
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
  lastWipeCycle: number;
  lastCursorCol: number | null;
  yMaxMs: number;
  publishCycle: Int32Array;
  leaseCycleByEndpoint: Map<string, Int32Array>;
  userCycleByEndpoint: Map<string, Int32Array>;
  publishBins: Float32Array;
  publishPeakBins: Float32Array;
  publishSumBins: Float64Array;
  publishCountBins: Uint16Array;
  leaseBinsByEndpoint: Map<string, Float32Array>;
  leasePeakBinsByEndpoint: Map<string, Float32Array>;
  leaseSumByEndpoint: Map<string, Float64Array>;
  leaseCountByEndpoint: Map<string, Uint16Array>;
  userBinsByEndpoint: Map<string, Float32Array>;
  userPeakBinsByEndpoint: Map<string, Float32Array>;
  userSumByEndpoint: Map<string, Float64Array>;
  userCountByEndpoint: Map<string, Uint16Array>;
};

type TraceCursorPosition = {
  col: number;
  cycle: number;
};

type TracePalette = {
  background: string;
  grid: string;
  axis: string;
  label: string;
  publish: string;
  cursor: string;
  waitingText: string;
};

const LIGHT_TRACE_PALETTE: TracePalette = {
  background: "#f4f8fd",
  grid: "#d9e4f0",
  axis: "#bac9da",
  label: "#5d6f86",
  publish: "#0ea5e9",
  cursor: "#e8a317",
  waitingText: "#7a8ea8",
};

const DARK_TRACE_PALETTE: TracePalette = {
  background: "#0f172a",
  grid: "#1e293b",
  axis: "#334155",
  label: "#cbd5e1",
  publish: "#38bdf8",
  cursor: "#fbbf24",
  waitingText: "#94a3b8",
};
const CURSOR_LEAD_COLS = 2;
const MIN_Y_MAX_MS = 0.1;
const DEFAULT_MANUAL_Y_MAX_MS = 5.0;

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
  const measuredHeight = Math.floor(canvas.clientHeight || 320);
  const height = clamp(measuredHeight, 240, 460);
  const left = 64;
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
    lastWipeCycle: 0,
    lastCursorCol: null,
    yMaxMs,
    publishCycle: new Int32Array(cycle),
    leaseCycleByEndpoint: new Map<string, Int32Array>(),
    userCycleByEndpoint: new Map<string, Int32Array>(),
    publishBins: makeNaNBins(layout.cols),
    publishPeakBins: makeNaNBins(layout.cols),
    publishSumBins: new Float64Array(layout.cols),
    publishCountBins: new Uint16Array(layout.cols),
    leaseBinsByEndpoint: new Map<string, Float32Array>(),
    leasePeakBinsByEndpoint: new Map<string, Float32Array>(),
    leaseSumByEndpoint: new Map<string, Float64Array>(),
    leaseCountByEndpoint: new Map<string, Uint16Array>(),
    userBinsByEndpoint: new Map<string, Float32Array>(),
    userPeakBinsByEndpoint: new Map<string, Float32Array>(),
    userSumByEndpoint: new Map<string, Float64Array>(),
    userCountByEndpoint: new Map<string, Uint16Array>(),
  };
}

function addColumnNeighborhood(changed: Set<number>, col: number, cols: number): void {
  if (cols <= 0) {
    return;
  }
  for (let offset = -1; offset <= 1; offset += 1) {
    const wrapped = (col + offset + cols) % cols;
    changed.add(wrapped);
  }
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

function forwardColumnDelta(
  previous: TraceCursorPosition,
  next: TraceCursorPosition,
  cols: number
): number {
  return (next.cycle - previous.cycle) * cols + (next.col - previous.col);
}

function clearColumn(state: RendererState, col: number): void {
  state.publishBins[col] = Number.NaN;
  state.publishPeakBins[col] = Number.NaN;
  state.publishSumBins[col] = 0;
  state.publishCountBins[col] = 0;

  for (const leaseBins of state.leaseBinsByEndpoint.values()) {
    leaseBins[col] = Number.NaN;
  }
  for (const leasePeakBins of state.leasePeakBinsByEndpoint.values()) {
    leasePeakBins[col] = Number.NaN;
  }
  for (const leaseSums of state.leaseSumByEndpoint.values()) {
    leaseSums[col] = 0;
  }
  for (const leaseCounts of state.leaseCountByEndpoint.values()) {
    leaseCounts[col] = 0;
  }
  for (const userBins of state.userBinsByEndpoint.values()) {
    userBins[col] = Number.NaN;
  }
  for (const userPeakBins of state.userPeakBinsByEndpoint.values()) {
    userPeakBins[col] = Number.NaN;
  }
  for (const userSums of state.userSumByEndpoint.values()) {
    userSums[col] = 0;
  }
  for (const userCounts of state.userCountByEndpoint.values()) {
    userCounts[col] = 0;
  }
}

function clearAllColumns(state: RendererState): void {
  state.publishBins.fill(Number.NaN);
  state.publishPeakBins.fill(Number.NaN);
  state.publishSumBins.fill(0);
  state.publishCountBins.fill(0);

  for (const leaseBins of state.leaseBinsByEndpoint.values()) {
    leaseBins.fill(Number.NaN);
  }
  for (const leasePeakBins of state.leasePeakBinsByEndpoint.values()) {
    leasePeakBins.fill(Number.NaN);
  }
  for (const leaseSums of state.leaseSumByEndpoint.values()) {
    leaseSums.fill(0);
  }
  for (const leaseCounts of state.leaseCountByEndpoint.values()) {
    leaseCounts.fill(0);
  }
  for (const userBins of state.userBinsByEndpoint.values()) {
    userBins.fill(Number.NaN);
  }
  for (const userPeakBins of state.userPeakBinsByEndpoint.values()) {
    userPeakBins.fill(Number.NaN);
  }
  for (const userSums of state.userSumByEndpoint.values()) {
    userSums.fill(0);
  }
  for (const userCounts of state.userCountByEndpoint.values()) {
    userCounts.fill(0);
  }
}

function clearColumnsBetweenPositions(
  state: RendererState,
  previous: TraceCursorPosition,
  next: TraceCursorPosition,
  changedCols: Set<number>
): boolean {
  const delta = forwardColumnDelta(previous, next, state.layout.cols);
  if (delta <= 1) {
    return false;
  }

  if (delta > state.layout.cols) {
    clearAllColumns(state);
    for (let col = 0; col < state.layout.cols; col += 1) {
      changedCols.add(col);
    }
    return true;
  }

  for (let step = 1; step < delta; step += 1) {
    const col = (previous.col + step) % state.layout.cols;
    clearColumn(state, col);
    changedCols.add(col);
  }
  return true;
}

function yFromMs(valueMs: number, yMaxMs: number, layout: PlotLayout): number {
  const ratio = clamp(valueMs / Math.max(yMaxMs, 1e-9), 0, 1);
  return layout.plotBottom - ratio * (layout.plotBottom - layout.plotTop);
}

function clearRange(
  context: CanvasRenderingContext2D,
  layout: PlotLayout,
  startCol: number,
  endCol: number,
  palette: TracePalette
): void {
  const start = clamp(startCol, 0, layout.cols - 1);
  const end = clamp(endCol, 0, layout.cols - 1);
  if (end < start) {
    return;
  }
  const x0 = layout.left + start;
  const width = end - start + 1;
  context.fillStyle = palette.background;
  context.fillRect(x0, layout.top, width, layout.plotHeight);

  context.strokeStyle = palette.grid;
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
  context.strokeStyle = palette.axis;
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
    alpha = 1,
    lineDash = [],
    startCol,
    endCol,
    yMaxMs,
    layout,
  }: {
    color: string;
    lineWidth: number;
    alpha?: number;
    lineDash?: number[];
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
  context.globalAlpha = alpha;
  context.setLineDash(lineDash);
  context.beginPath();
  const overflowStarts: number[] = [];
  let previousCol: number | null = null;
  let previousValue = Number.NaN;
  let previousWasOverflow = false;
  for (let col = from - 1; col >= 0; col -= 1) {
    const valueMs = bins[col];
    if (!Number.isFinite(valueMs)) {
      continue;
    }
    previousCol = col;
    previousValue = valueMs;
    previousWasOverflow = valueMs > yMaxMs;
    break;
  }
  for (let col = from; col <= to; col += 1) {
    const valueMs = bins[col];
    if (!Number.isFinite(valueMs)) {
      continue;
    }
    const isOverflow = valueMs > yMaxMs;
    if (isOverflow && !previousWasOverflow) {
      overflowStarts.push(col);
    }

    if (previousCol !== null && Number.isFinite(previousValue)) {
      const previousOverflow = previousValue > yMaxMs;
      if (!(previousOverflow && isOverflow)) {
        const x0 = layout.left + previousCol + 0.5;
        const y0 = previousOverflow
          ? layout.plotTop
          : yFromMs(previousValue, yMaxMs, layout);
        const x1 = layout.left + col + 0.5;
        const y1 = isOverflow ? layout.plotTop : yFromMs(valueMs, yMaxMs, layout);
        context.moveTo(x0, y0);
        context.lineTo(x1, y1);
      }
    }
    previousCol = col;
    previousValue = valueMs;
    previousWasOverflow = isOverflow;
  }
  context.stroke();
  context.setLineDash([]);
  context.globalAlpha = 1;

  if (overflowStarts.length > 0) {
    context.fillStyle = color;
    context.globalAlpha = Math.min(1, alpha + 0.1);
    for (const col of overflowStarts) {
      const x = layout.left + col;
      context.fillRect(x, layout.plotTop, 1, 3);
    }
    context.globalAlpha = 1;
  }
}

function drawPeakWhiskersRange(
  context: CanvasRenderingContext2D,
  avgBins: Float32Array,
  peakBins: Float32Array,
  {
    color,
    alpha,
    lineDash = [],
    startCol,
    endCol,
    yMaxMs,
    layout,
  }: {
    color: string;
    alpha: number;
    lineDash?: number[];
    startCol: number;
    endCol: number;
    yMaxMs: number;
    layout: PlotLayout;
  }
): void {
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.globalAlpha = alpha;
  context.setLineDash(lineDash);
  for (let col = startCol; col <= endCol; col += 1) {
    const avgMs = avgBins[col];
    const peakMs = peakBins[col];
    if (!Number.isFinite(avgMs) || !Number.isFinite(peakMs) || peakMs <= avgMs) {
      continue;
    }
    const x = layout.left + col + 0.5;
    const yLow = avgMs > yMaxMs ? layout.plotTop : yFromMs(avgMs, yMaxMs, layout);
    const yHigh = peakMs > yMaxMs ? layout.plotTop : yFromMs(peakMs, yMaxMs, layout);
    context.beginPath();
    context.moveTo(x, yLow);
    context.lineTo(x, yHigh);
    context.stroke();
  }
  context.setLineDash([]);
  context.globalAlpha = 1;
}

function drawFilledBinsRange(
  context: CanvasRenderingContext2D,
  bins: Float32Array,
  {
    color,
    alpha,
    startCol,
    endCol,
    yMaxMs,
    layout,
  }: {
    color: string;
    alpha: number;
    startCol: number;
    endCol: number;
    yMaxMs: number;
    layout: PlotLayout;
  }
): void {
  const from = Math.max(0, startCol - 1);
  const to = Math.min(layout.cols - 1, endCol + 1);
  let firstCol: number | null = null;
  let lastCol: number | null = null;

  for (let col = from; col <= to; col += 1) {
    const valueMs = bins[col];
    if (!Number.isFinite(valueMs) || valueMs <= 0) {
      continue;
    }
    if (firstCol === null) {
      firstCol = col;
    }
    lastCol = col;
  }

  if (firstCol === null || lastCol === null) {
    return;
  }

  context.fillStyle = color;
  context.globalAlpha = alpha;
  context.beginPath();
  context.moveTo(layout.left + firstCol + 0.5, layout.plotBottom);

  for (let col = firstCol; col <= lastCol; col += 1) {
    const valueMs = bins[col];
    if (!Number.isFinite(valueMs) || valueMs <= 0) {
      continue;
    }
    const clampedMs = Math.min(valueMs, yMaxMs);
    const x = layout.left + col + 0.5;
    const y = yFromMs(clampedMs, yMaxMs, layout);
    context.lineTo(x, y);
  }
  context.lineTo(layout.left + lastCol + 0.5, layout.plotBottom);
  context.closePath();
  context.fill();
  context.globalAlpha = 1;
}

function drawSelectedSubscriberFlameRange(
  context: CanvasRenderingContext2D,
  {
    leaseBins,
    userBins,
    color,
    startCol,
    endCol,
    yMaxMs,
    layout,
  }: {
    leaseBins: Float32Array;
    userBins: Float32Array | null;
    color: string;
    startCol: number;
    endCol: number;
    yMaxMs: number;
    layout: PlotLayout;
  }
): void {
  drawFilledBinsRange(context, leaseBins, {
    color,
    alpha: 0.18,
    startCol,
    endCol,
    yMaxMs,
    layout,
  });

  if (userBins !== null) {
    const clampedUserBins = new Float32Array(userBins.length);
    clampedUserBins.fill(Number.NaN);
    for (let col = startCol; col <= endCol && col < userBins.length; col += 1) {
      const userMs = userBins[col];
      const leaseMs = leaseBins[col];
      if (!Number.isFinite(userMs)) {
        continue;
      }
      clampedUserBins[col] = Number.isFinite(leaseMs) ? Math.min(userMs, leaseMs) : userMs;
    }
    drawFilledBinsRange(context, clampedUserBins, {
      color,
      alpha: 0.42,
      startCol,
      endCol,
      yMaxMs,
      layout,
    });
    drawLineRange(context, clampedUserBins, {
      color,
      lineWidth: 1.1,
      alpha: 0.95,
      startCol,
      endCol,
      yMaxMs,
      layout,
    });
  }

  drawLineRange(context, leaseBins, {
    color,
    lineWidth: 1.15,
    alpha: 0.9,
    startCol,
    endCol,
    yMaxMs,
    layout,
  });
}

function drawRange(
  context: CanvasRenderingContext2D,
  state: RendererState,
  startCol: number,
  endCol: number,
  subscriberMetric: "lease_time_ns" | "user_span_ns",
  selectedSubscriberEndpointId: string | null,
  leaseColorMap?: Record<string, string>,
  palette: TracePalette = DARK_TRACE_PALETTE
): void {
  clearRange(context, state.layout, startCol, endCol, palette);
  if (selectedSubscriberEndpointId) {
    const selectedLeaseBins =
      state.leaseBinsByEndpoint.get(selectedSubscriberEndpointId) ?? null;
    if (selectedLeaseBins) {
      drawSelectedSubscriberFlameRange(context, {
        leaseBins: selectedLeaseBins,
        userBins: state.userBinsByEndpoint.get(selectedSubscriberEndpointId) ?? null,
        color: leaseColorForEndpoint(selectedSubscriberEndpointId, leaseColorMap),
        startCol,
        endCol,
        yMaxMs: state.yMaxMs,
        layout: state.layout,
      });
    }
  } else {
  const binsByEndpoint =
    subscriberMetric === "lease_time_ns"
      ? state.leaseBinsByEndpoint
      : state.userBinsByEndpoint;
  const peakBinsByEndpoint =
    subscriberMetric === "lease_time_ns"
      ? state.leasePeakBinsByEndpoint
      : state.userPeakBinsByEndpoint;

  for (const [endpointId, bins] of binsByEndpoint.entries()) {
    if (selectedSubscriberEndpointId && endpointId !== selectedSubscriberEndpointId) {
      continue;
    }
    const peakBins = peakBinsByEndpoint.get(endpointId);
    if (peakBins) {
      drawPeakWhiskersRange(context, bins, peakBins, {
        color: leaseColorForEndpoint(endpointId, leaseColorMap),
        alpha: 0.3,
        startCol,
        endCol,
        yMaxMs: state.yMaxMs,
        layout: state.layout,
      });
    }
    drawLineRange(context, bins, {
      color: leaseColorForEndpoint(endpointId, leaseColorMap),
      lineWidth: 1.1,
      startCol,
      endCol,
      yMaxMs: state.yMaxMs,
      layout: state.layout,
    });
  }
  }
  drawPeakWhiskersRange(context, state.publishBins, state.publishPeakBins, {
    color: palette.publish,
    alpha: 0.35,
    startCol,
    endCol,
    yMaxMs: state.yMaxMs,
    layout: state.layout,
  });
  drawLineRange(context, state.publishBins, {
    color: palette.publish,
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
  windowSeconds: number,
  palette: TracePalette
): void {
  const { layout } = state;
  context.fillStyle = palette.background;
  context.fillRect(0, 0, layout.left - 2, layout.height);
  context.fillRect(layout.left, layout.plotBottom + 1, layout.plotWidth, layout.bottom + 6);

  if (state.lastCursorCol !== null) {
    const x = layout.left + state.lastCursorCol + 0.5;
    context.strokeStyle = palette.cursor;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(x, layout.top);
    context.lineTo(x, layout.top + layout.plotHeight);
    context.stroke();
  }

  context.fillStyle = palette.label;
  context.font = '11px "Avenir Next", sans-serif';
  context.textAlign = "right";
  context.fillText(
    `${windowSeconds.toFixed(1)}s`,
    layout.left + layout.plotWidth - 2,
    layout.top + layout.plotHeight + 16
  );
  context.textAlign = "left";
  context.fillText(`${state.yMaxMs.toFixed(2)} ms`, 6, layout.plotTop + 8);
  context.fillText("0 ms", 8, layout.plotBottom + 4);
}

function roundUpLog10Ms(valueMs: number): number {
  if (!Number.isFinite(valueMs) || valueMs <= 0) {
    return MIN_Y_MAX_MS;
  }
  const exponent = Math.floor(Math.log10(valueMs));
  let scale = 10 ** exponent;
  let mantissa = Math.ceil(valueMs / scale);
  if (mantissa > 9) {
    scale *= 10;
    mantissa = 1;
  }
  return Math.max(MIN_Y_MAX_MS, mantissa * scale);
}

function estimateAutoYMaxMsFromRateHz(rateHz: number): number {
  if (!Number.isFinite(rateHz) || rateHz <= 0) {
    return DEFAULT_MANUAL_Y_MAX_MS;
  }
  const nominalPublishDeltaMs = 1000 / rateHz;
  return roundUpLog10Ms(nominalPublishDeltaMs * 1.25);
}

function getOrCreateEndpointSeries(
  binsByEndpoint: Map<string, Float32Array>,
  peakBinsByEndpoint: Map<string, Float32Array>,
  sumByEndpoint: Map<string, Float64Array>,
  countByEndpoint: Map<string, Uint16Array>,
  cycleByEndpoint: Map<string, Int32Array>,
  endpointId: string,
  cols: number
): {
  bins: Float32Array;
  peakBins: Float32Array;
  sumBins: Float64Array;
  countBins: Uint16Array;
  cycleBins: Int32Array;
} {
  let bins = binsByEndpoint.get(endpointId);
  let peakBins = peakBinsByEndpoint.get(endpointId);
  let sumBins = sumByEndpoint.get(endpointId);
  let countBins = countByEndpoint.get(endpointId);
  let cycleBins = cycleByEndpoint.get(endpointId);

  if (!bins) {
    bins = makeNaNBins(cols);
    binsByEndpoint.set(endpointId, bins);
  }
  if (!peakBins) {
    peakBins = makeNaNBins(cols);
    peakBinsByEndpoint.set(endpointId, peakBins);
  }
  if (!sumBins) {
    sumBins = new Float64Array(cols);
    sumByEndpoint.set(endpointId, sumBins);
  }
  if (!countBins) {
    countBins = new Uint16Array(cols);
    countByEndpoint.set(endpointId, countBins);
  }
  if (!cycleBins) {
    cycleBins = new Int32Array(cols);
    cycleBins.fill(-2147483648);
    cycleByEndpoint.set(endpointId, cycleBins);
  }

  return { bins, peakBins, sumBins, countBins, cycleBins };
}

export function TraceTimingPanel({
  samples,
  publisherProcessId,
  publisherEndpointId,
  nominalPublishRateHz,
  topic,
  topicScope,
  leaseColorMap,
  selectedSubscriberEndpointId = null,
  windowSeconds,
  onWindowSecondsChange,
  darkMode = false,
}: TraceTimingPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasPixelSizeRef = useRef<{ width: number; height: number } | null>(null);
  const rendererRef = useRef<RendererState | null>(null);
  const lastBatchRef = useRef<TimingTraceSample[] | null>(null);
  const previousAutoModeRef = useRef<boolean>(true);
  const windowInputKeyboardEditRef = useRef(false);
  const [windowInput, setWindowInput] = useState(() => windowSeconds.toFixed(1));
  const [autoYAxis, setAutoYAxis] = useState(true);
  const [manualYMaxInput, setManualYMaxInput] = useState(
    `${DEFAULT_MANUAL_Y_MAX_MS.toFixed(2)}`
  );
  const [subscriberMetric, setSubscriberMetric] = useState<
    "lease_time_ns" | "user_span_ns"
  >("lease_time_ns");
  const selectedSubscriberColor = useMemo(
    () =>
      selectedSubscriberEndpointId
        ? leaseColorForEndpoint(selectedSubscriberEndpointId, leaseColorMap)
        : null,
    [leaseColorMap, selectedSubscriberEndpointId]
  );
  const palette = darkMode ? DARK_TRACE_PALETTE : LIGHT_TRACE_PALETTE;

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
  const commitWindowInput = (rawValue?: string) => {
    const parsed = parsePositiveFloat(rawValue ?? windowInput);
    if (parsed === null || !onWindowSecondsChange) {
      setWindowInput(windowSeconds.toFixed(1));
      return;
    }
    const clamped = clamp(parsed, 0.5, 30);
    onWindowSecondsChange(clamped);
    setWindowInput(clamped.toFixed(1));
  };
  const toggleYAxisMode = () => {
    if (autoYAxis) {
      const currentY =
        rendererRef.current?.yMaxMs
        ?? estimateAutoYMaxMsFromRateHz(nominalPublishRateHz);
      setManualYMaxInput(currentY.toFixed(2));
      setAutoYAxis(false);
      return;
    }
    setAutoYAxis(true);
  };

  useEffect(() => {
    setWindowInput(windowSeconds.toFixed(1));
  }, [windowSeconds]);

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
    const targetPixelWidth = Math.floor(layout.width * devicePixelRatio);
    const targetPixelHeight = Math.floor(layout.height * devicePixelRatio);
    const previousPixelSize = canvasPixelSizeRef.current;
    const sizeChanged =
      !previousPixelSize
      || previousPixelSize.width !== targetPixelWidth
      || previousPixelSize.height !== targetPixelHeight;
    if (sizeChanged) {
      canvas.width = targetPixelWidth;
      canvas.height = targetPixelHeight;
      canvasPixelSizeRef.current = {
        width: targetPixelWidth,
        height: targetPixelHeight,
      };
    }
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

    const windowNs = Math.max(1, windowSeconds * 1_000_000_000);
    const estimatedAutoYMaxMs = estimateAutoYMaxMsFromRateHz(nominalPublishRateHz);
    const desiredY = autoYAxis
      ? estimatedAutoYMaxMs
      : Math.max(MIN_Y_MAX_MS, manualYMaxMs ?? DEFAULT_MANUAL_Y_MAX_MS);

    let renderer = rendererRef.current;
    const needsReinit =
      renderer === null
      || sizeChanged
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
      lastBatchRef.current = null;
      context.fillStyle = palette.background;
      context.fillRect(0, 0, layout.width, layout.height);
    }

    if (renderer === null) {
      return;
    }

    const changedCols = new Set<number>();
    let newestTimestamp = renderer.lastTimestamp;
    let processedAny = false;
    let maxCycleSeen = renderer.lastWipeCycle;
    let sweepPosition: TraceCursorPosition | null = null;
    if (renderer.originNs !== null && Number.isFinite(renderer.lastTimestamp)) {
      sweepPosition = colForTimestamp(
        renderer.lastTimestamp,
        renderer.originNs,
        renderer.windowNs,
        renderer.layout.cols
      );
    }
    const incoming = samples !== lastBatchRef.current ? samples : [];
    if (samples !== lastBatchRef.current) {
      lastBatchRef.current = samples;
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
      const isLeaseMetric = sample.metric === "lease_time_ns";
      const isUserMetric = sample.metric === "user_span_ns";
      if (!isPublisherMetric && !isLeaseMetric && !isUserMetric) {
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
      maxCycleSeen = Math.max(maxCycleSeen, cycle);

      const valueMs = toMs(sample.value);
      if (!Number.isFinite(valueMs) || valueMs < 0) {
        continue;
      }

      const samplePosition = { col, cycle };
      if (sweepPosition !== null) {
        const delta = forwardColumnDelta(sweepPosition, samplePosition, renderer.layout.cols);
        if (delta > 0) {
          clearColumnsBetweenPositions(renderer, sweepPosition, samplePosition, changedCols);
          sweepPosition = samplePosition;
        }
      } else {
        sweepPosition = samplePosition;
      }

      if (isPublisherMetric) {
        if (cycle > renderer.publishCycle[col]) {
          renderer.publishCycle[col] = cycle;
          renderer.publishBins[col] = Number.NaN;
          renderer.publishPeakBins[col] = Number.NaN;
          renderer.publishSumBins[col] = 0;
          renderer.publishCountBins[col] = 0;
          changedCols.add(col);
        }
        const nextCount = Math.min(65535, renderer.publishCountBins[col] + 1);
        renderer.publishCountBins[col] = nextCount;
        renderer.publishSumBins[col] += valueMs;
        const nextAvg = renderer.publishSumBins[col] / nextCount;
        const currentAvg = renderer.publishBins[col];
        if (!Number.isFinite(currentAvg) || Math.abs(nextAvg - currentAvg) > 1e-6) {
          renderer.publishBins[col] = nextAvg;
          changedCols.add(col);
        }
        const currentPeak = renderer.publishPeakBins[col];
        if (!Number.isFinite(currentPeak) || valueMs > currentPeak) {
          renderer.publishPeakBins[col] = valueMs;
          changedCols.add(col);
        }
      } else {
        const endpointSeries = isLeaseMetric
          ? getOrCreateEndpointSeries(
            renderer.leaseBinsByEndpoint,
            renderer.leasePeakBinsByEndpoint,
            renderer.leaseSumByEndpoint,
            renderer.leaseCountByEndpoint,
            renderer.leaseCycleByEndpoint,
            sample.endpointId,
            renderer.layout.cols
          )
          : getOrCreateEndpointSeries(
            renderer.userBinsByEndpoint,
            renderer.userPeakBinsByEndpoint,
            renderer.userSumByEndpoint,
            renderer.userCountByEndpoint,
            renderer.userCycleByEndpoint,
            sample.endpointId,
            renderer.layout.cols
          );
        if (cycle > endpointSeries.cycleBins[col]) {
          endpointSeries.cycleBins[col] = cycle;
          endpointSeries.bins[col] = Number.NaN;
          endpointSeries.peakBins[col] = Number.NaN;
          endpointSeries.sumBins[col] = 0;
          endpointSeries.countBins[col] = 0;
          changedCols.add(col);
        }
        const nextCount = Math.min(65535, endpointSeries.countBins[col] + 1);
        endpointSeries.countBins[col] = nextCount;
        endpointSeries.sumBins[col] += valueMs;
        const nextAvg = endpointSeries.sumBins[col] / nextCount;
        const currentAvg = endpointSeries.bins[col];
        if (!Number.isFinite(currentAvg) || Math.abs(nextAvg - currentAvg) > 1e-6) {
          endpointSeries.bins[col] = nextAvg;
          changedCols.add(col);
        }
        const currentPeak = endpointSeries.peakBins[col];
        if (!Number.isFinite(currentPeak) || valueMs > currentPeak) {
          endpointSeries.peakBins[col] = valueMs;
          changedCols.add(col);
        }
      }

      newestTimestamp = Math.max(newestTimestamp, sample.timestamp);
      processedAny = true;
    }

    const autoModeToggledOn = autoYAxis && !previousAutoModeRef.current;
    previousAutoModeRef.current = autoYAxis;
    if (autoYAxis) {
      if (autoModeToggledOn) {
        renderer.yMaxMs = estimatedAutoYMaxMs;
      } else if (maxCycleSeen > renderer.lastWipeCycle) {
        renderer.lastWipeCycle = maxCycleSeen;
        renderer.yMaxMs = estimatedAutoYMaxMs;
      }
    } else {
      renderer.yMaxMs = Math.max(MIN_Y_MAX_MS, manualYMaxMs ?? DEFAULT_MANUAL_Y_MAX_MS);
    }
    if (autoYAxis) {
      const autoYText = renderer.yMaxMs.toFixed(2);
      if (manualYMaxInput !== autoYText) {
        setManualYMaxInput(autoYText);
      }
    }

    if (processedAny && renderer.originNs !== null) {
      const latest = colForTimestamp(
        newestTimestamp,
        renderer.originNs,
        renderer.windowNs,
        renderer.layout.cols
      );
      changedCols.add(latest.col);
      if (renderer.lastCursorCol !== null) {
        addColumnNeighborhood(
          changedCols,
          renderer.lastCursorCol,
          renderer.layout.cols
        );
      }
      const cursorCol = (latest.col + CURSOR_LEAD_COLS) % renderer.layout.cols;
      addColumnNeighborhood(changedCols, cursorCol, renderer.layout.cols);
      renderer.lastCursorCol = cursorCol;
      renderer.lastTimestamp = newestTimestamp;
    }

    if (needsReinit || changedCols.size > 0) {
      context.fillStyle = palette.background;
      context.fillRect(0, 0, renderer.layout.width, renderer.layout.height);
      drawRange(
        context,
        renderer,
        0,
        renderer.layout.cols - 1,
        subscriberMetric,
        selectedSubscriberEndpointId,
        leaseColorMap,
        palette
      );
    }

    if (renderer.lastTimestamp <= 0) {
      context.fillStyle = palette.background;
      context.fillRect(0, 0, renderer.layout.width, renderer.layout.height);
      context.fillStyle = palette.waitingText;
      context.font = '12px "Avenir Next", sans-serif';
      context.fillText("Waiting for trace samples...", renderer.layout.left, 26);
      drawLabelsAndCursor(context, renderer, windowSeconds, palette);
      return;
    }

    drawLabelsAndCursor(context, renderer, windowSeconds, palette);
  }, [
    autoYAxis,
    darkMode,
    effectiveTopicScope,
    leaseColorMap,
    manualYMaxMs,
    nominalPublishRateHz,
    publisherEndpointId,
    publisherProcessId,
    publisherSignature,
    selectedSubscriberEndpointId,
    samples,
    subscriberMetric,
    scopeSignature,
    windowSeconds,
    palette,
  ]);

  return (
    <div className="timing-trace">
      <div className="timing-trace__controls">
        <div className="timing-trace__controls-left">
          <label className="timing-trace__axis-input">
            <span>Window (s)</span>
            <input
              type="number"
              min={0.5}
              max={30}
              step="0.5"
              value={windowInput}
              onChange={(event) => {
                const nextValue = event.target.value;
                setWindowInput(nextValue);
                if (!windowInputKeyboardEditRef.current) {
                  commitWindowInput(nextValue);
                }
              }}
              onMouseDown={() => {
                windowInputKeyboardEditRef.current = false;
              }}
              onBlur={() => {
                windowInputKeyboardEditRef.current = false;
                commitWindowInput();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  windowInputKeyboardEditRef.current = false;
                  commitWindowInput();
                  return;
                }
                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                  event.preventDefault();
                  windowInputKeyboardEditRef.current = false;
                  const current = parsePositiveFloat(windowInput) ?? windowSeconds;
                  const delta = event.key === "ArrowUp" ? 0.5 : -0.5;
                  const next = clamp(current + delta, 0.5, 30);
                  setWindowInput(next.toFixed(1));
                  onWindowSecondsChange?.(next);
                  return;
                }
                if (
                  event.key.length === 1
                  || event.key === "Backspace"
                  || event.key === "Delete"
                ) {
                  windowInputKeyboardEditRef.current = true;
                }
              }}
            />
          </label>
          <span className="timing-trace__legend-item is-static">
            <i style={{ background: palette.publish }} />
            Publish Delta
          </span>
          {selectedSubscriberEndpointId ? (
            <>
              <span className="timing-trace__legend-item is-static">
                <i
                  style={{
                    background: "transparent",
                    border: `2px solid ${selectedSubscriberColor ?? "#94a3b8"}`,
                  }}
                />
                Lease Time
              </span>
              <span className="timing-trace__legend-item is-static">
                <i
                  style={{
                    background: selectedSubscriberColor ?? "#94a3b8",
                  }}
                />
                User Span
              </span>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`timing-trace__legend-item timing-trace__legend-toggle ${
                  subscriberMetric === "lease_time_ns" ? "is-active" : ""
                }`}
                onClick={() => setSubscriberMetric("lease_time_ns")}
                aria-pressed={subscriberMetric === "lease_time_ns"}
              >
                Lease Time
              </button>
              <button
                type="button"
                className={`timing-trace__legend-item timing-trace__legend-toggle ${
                  subscriberMetric === "user_span_ns" ? "is-active" : ""
                }`}
                onClick={() => setSubscriberMetric("user_span_ns")}
                aria-pressed={subscriberMetric === "user_span_ns"}
              >
                User Span
              </button>
            </>
          )}
        </div>
        <div className="timing-trace__controls-right">
          <label className="timing-trace__axis-input timing-trace__axis-input--ymax">
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
          <button
            type="button"
            role="switch"
            aria-checked={autoYAxis}
            className={`timing-trace__mode-toggle ${autoYAxis ? "is-auto" : "is-fixed"}`}
            onClick={toggleYAxisMode}
            title={autoYAxis ? "Switch to Fixed Y" : "Switch to Auto Y"}
          >
            <span className="timing-trace__mode-toggle-label">
              {autoYAxis ? "Auto" : "Fixed"}
            </span>
          </button>
        </div>
      </div>
      <canvas ref={canvasRef} className="timing-trace__canvas" />
    </div>
  );
}
