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
  selectedLeaseEndpointId?: string | null;
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
  lastWipeCycle: number;
  lastCursorCol: number | null;
  yMaxMs: number;
  publishCycle: Int32Array;
  attrCycle: Int32Array;
  leaseCycleByEndpoint: Map<string, Int32Array>;
  publishBins: Float32Array;
  publishPeakBins: Float32Array;
  publishSumBins: Float64Array;
  publishCountBins: Uint16Array;
  attrBins: Float32Array;
  leaseBinsByEndpoint: Map<string, Float32Array>;
  leasePeakBinsByEndpoint: Map<string, Float32Array>;
  leaseSumByEndpoint: Map<string, Float64Array>;
  leaseCountByEndpoint: Map<string, Uint16Array>;
};

const BG_COLOR = "#0f172a";
const GRID_COLOR = "#1e293b";
const AXIS_COLOR = "#334155";
const LABEL_COLOR = "#cbd5e1";
const PUBLISH_COLOR = "#38bdf8";
const ATTR_BP_COLOR = "#f59e0b";
const CURSOR_COLOR = "#fbbf24";
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
    attrCycle: new Int32Array(cycle),
    leaseCycleByEndpoint: new Map<string, Int32Array>(),
    publishBins: makeNaNBins(layout.cols),
    publishPeakBins: makeNaNBins(layout.cols),
    publishSumBins: new Float64Array(layout.cols),
    publishCountBins: new Uint16Array(layout.cols),
    attrBins: makeNaNBins(layout.cols),
    leaseBinsByEndpoint: new Map<string, Float32Array>(),
    leasePeakBinsByEndpoint: new Map<string, Float32Array>(),
    leaseSumByEndpoint: new Map<string, Float64Array>(),
    leaseCountByEndpoint: new Map<string, Uint16Array>(),
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

  if (overflowStarts.length > 0) {
    context.fillStyle = color;
    context.globalAlpha = 0.72;
    for (const col of overflowStarts) {
      const x = layout.left + col;
      context.fillRect(x, layout.plotTop, 1, 3);
    }
    context.globalAlpha = 1;
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
  const overflowStarts: number[] = [];
  let previousWasOverflow = false;
  for (let col = startCol; col <= endCol; col += 1) {
    const valueMs = bins[col];
    if (!Number.isFinite(valueMs)) {
      previousWasOverflow = false;
      continue;
    }
    const isOverflow = valueMs > yMaxMs;
    if (isOverflow && !previousWasOverflow) {
      overflowStarts.push(col);
    }
    previousWasOverflow = isOverflow;
    if (isOverflow) {
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
  if (overflowStarts.length > 0) {
    context.fillStyle = ATTR_BP_COLOR;
    context.globalAlpha = 0.75;
    for (const col of overflowStarts) {
      const x = layout.left + col;
      context.fillRect(x, layout.plotTop + 1, 1, 2);
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
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.globalAlpha = alpha;
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
  context.globalAlpha = 1;
}

function drawRange(
  context: CanvasRenderingContext2D,
  state: RendererState,
  startCol: number,
  endCol: number,
  showAttrBp: boolean,
  showSubscribers: boolean,
  selectedLeaseEndpointId: string | null,
  leaseColorMap?: Record<string, string>
): void {
  clearRange(context, state.layout, startCol, endCol);
  if (showAttrBp) {
    drawAttrRange(context, state.attrBins, {
      startCol,
      endCol,
      yMaxMs: state.yMaxMs,
      layout: state.layout,
    });
  }
  if (showSubscribers) {
    for (const [endpointId, bins] of state.leaseBinsByEndpoint.entries()) {
      if (selectedLeaseEndpointId && endpointId !== selectedLeaseEndpointId) {
        continue;
      }
      const peakBins = state.leasePeakBinsByEndpoint.get(endpointId);
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
    color: PUBLISH_COLOR,
    alpha: 0.35,
    startCol,
    endCol,
    yMaxMs: state.yMaxMs,
    layout: state.layout,
  });
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

export function TraceTimingPanel({
  samples,
  publisherProcessId,
  publisherEndpointId,
  nominalPublishRateHz,
  topic,
  topicScope,
  leaseColorMap,
  selectedLeaseEndpointId = null,
  windowSeconds,
  onWindowSecondsChange,
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
  const [showAttrBp, setShowAttrBp] = useState(true);
  const [showSubscribers, setShowSubscribers] = useState(true);

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
      context.fillStyle = BG_COLOR;
      context.fillRect(0, 0, layout.width, layout.height);
    }

    if (renderer === null) {
      return;
    }

    const changedCols = new Set<number>();
    let newestTimestamp = renderer.lastTimestamp;
    let processedAny = false;
    let maxCycleSeen = renderer.lastWipeCycle;
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
      maxCycleSeen = Math.max(maxCycleSeen, cycle);

      const valueMs = toMs(sample.value);
      if (!Number.isFinite(valueMs) || valueMs < 0) {
        continue;
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
      } else if (isAttrMetric) {
        if (cycle > renderer.attrCycle[col]) {
          renderer.attrCycle[col] = cycle;
          renderer.attrBins[col] = Number.NaN;
          changedCols.add(col);
        }
        const current = renderer.attrBins[col];
        if (!Number.isFinite(current) || valueMs > current) {
          renderer.attrBins[col] = valueMs;
          changedCols.add(col);
        }
      } else {
        let leaseBins = renderer.leaseBinsByEndpoint.get(sample.endpointId);
        let leasePeakBins = renderer.leasePeakBinsByEndpoint.get(sample.endpointId);
        let leaseSumBins = renderer.leaseSumByEndpoint.get(sample.endpointId);
        let leaseCountBins = renderer.leaseCountByEndpoint.get(sample.endpointId);
        let leaseCycle = renderer.leaseCycleByEndpoint.get(sample.endpointId);
        if (!leaseBins) {
          leaseBins = makeNaNBins(renderer.layout.cols);
          renderer.leaseBinsByEndpoint.set(sample.endpointId, leaseBins);
        }
        if (!leasePeakBins) {
          leasePeakBins = makeNaNBins(renderer.layout.cols);
          renderer.leasePeakBinsByEndpoint.set(sample.endpointId, leasePeakBins);
        }
        if (!leaseSumBins) {
          leaseSumBins = new Float64Array(renderer.layout.cols);
          renderer.leaseSumByEndpoint.set(sample.endpointId, leaseSumBins);
        }
        if (!leaseCountBins) {
          leaseCountBins = new Uint16Array(renderer.layout.cols);
          renderer.leaseCountByEndpoint.set(sample.endpointId, leaseCountBins);
        }
        if (!leaseCycle) {
          leaseCycle = new Int32Array(renderer.layout.cols);
          leaseCycle.fill(-2147483648);
          renderer.leaseCycleByEndpoint.set(sample.endpointId, leaseCycle);
        }
        if (cycle > leaseCycle[col]) {
          leaseCycle[col] = cycle;
          leaseBins[col] = Number.NaN;
          leasePeakBins[col] = Number.NaN;
          leaseSumBins[col] = 0;
          leaseCountBins[col] = 0;
          changedCols.add(col);
        }
        const nextCount = Math.min(65535, leaseCountBins[col] + 1);
        leaseCountBins[col] = nextCount;
        leaseSumBins[col] += valueMs;
        const nextAvg = leaseSumBins[col] / nextCount;
        const currentAvg = leaseBins[col];
        if (!Number.isFinite(currentAvg) || Math.abs(nextAvg - currentAvg) > 1e-6) {
          leaseBins[col] = nextAvg;
          changedCols.add(col);
        }
        const currentPeak = leasePeakBins[col];
        if (!Number.isFinite(currentPeak) || valueMs > currentPeak) {
          leasePeakBins[col] = valueMs;
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
      context.fillStyle = BG_COLOR;
      context.fillRect(0, 0, renderer.layout.width, renderer.layout.height);
      drawRange(
        context,
        renderer,
        0,
        renderer.layout.cols - 1,
        showAttrBp,
        showSubscribers,
        selectedLeaseEndpointId,
        leaseColorMap
      );
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
    nominalPublishRateHz,
    publisherEndpointId,
    publisherProcessId,
    publisherSignature,
    selectedLeaseEndpointId,
    samples,
    showAttrBp,
    showSubscribers,
    scopeSignature,
    windowSeconds,
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
            <i style={{ background: PUBLISH_COLOR }} />
            Publish Delta
          </span>
          <button
            type="button"
            className={`timing-trace__legend-item timing-trace__legend-toggle ${
              showAttrBp ? "is-active" : ""
            }`}
            onClick={() => setShowAttrBp((previous) => !previous)}
            aria-pressed={showAttrBp}
          >
            <i style={{ background: ATTR_BP_COLOR }} />
            Backpressure (all subs)
          </button>
          <button
            type="button"
            className={`timing-trace__legend-item timing-trace__legend-toggle ${
              showSubscribers ? "is-active" : ""
            }`}
            onClick={() => setShowSubscribers((previous) => !previous)}
            aria-pressed={showSubscribers}
          >
            <i
              style={{
                background: selectedLeaseEndpointId
                  ? leaseColorForEndpoint(selectedLeaseEndpointId, leaseColorMap)
                  : "#93c5fd",
              }}
            />
            Subscribers
          </button>
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
