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
  windowSeconds?: number;
};

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

type SeriesBin = {
  hasValue: boolean;
  maxMs: number;
};

type TracePoint = {
  timestamp: number;
  valueMs: number;
};

function buildSeriesBins(
  series: TracePoint[],
  {
    left,
    plotWidth,
    yMaxMs,
    xOf,
  }: {
    left: number;
    plotWidth: number;
    yMaxMs: number;
    xOf: (timestamp: number) => number;
  }
): SeriesBin[] {
  const widthCols = Math.max(1, Math.floor(plotWidth));
  const bins: SeriesBin[] = Array.from({ length: widthCols }, () => ({
    hasValue: false,
    maxMs: 0,
  }));
  for (const sample of series) {
    const valueMs = sample.valueMs;
    if (valueMs > yMaxMs) {
      continue;
    }
    const x = xOf(sample.timestamp);
    const col = clamp(Math.floor(x - left), 0, widthCols - 1);
    const bin = bins[col];
    if (!bin.hasValue || valueMs > bin.maxMs) {
      bin.hasValue = true;
      bin.maxMs = valueMs;
    }
  }
  return bins;
}

export function TraceTimingPanel({
  samples,
  publisherProcessId,
  publisherEndpointId,
  topic,
  topicScope,
  leaseColorMap,
  windowSeconds = 2.0,
}: TraceTimingPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const originRef = useRef<number | null>(null);
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

  const filtered = useMemo(
    () =>
      samples.filter(
        (sample) =>
          effectiveTopicScope.some(
            (candidateTopic) =>
              sample.topic === candidateTopic
              || sample.topic.startsWith(`${candidateTopic}:`)
          )
          && Number.isFinite(sample.timestamp)
          && Number.isFinite(sample.value)
      ),
    [effectiveTopicScope, samples]
  );
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(440, Math.floor(canvas.clientWidth));
    const height = 220;
    canvas.width = Math.floor(width * devicePixelRatio);
    canvas.height = Math.floor(height * devicePixelRatio);

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);

    const left = 52;
    const right = 16;
    const top = 12;
    const bottom = 24;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const plotTop = top + 2;
    const plotBottom = top + plotHeight - 2;

    context.fillStyle = "#0f172a";
    context.fillRect(0, 0, width, height);

    const windowNs = Math.max(1, windowSeconds * 1_000_000_000);
    const latestTimestamp = filtered.reduce(
      (latest, sample) => Math.max(latest, sample.timestamp),
      0
    );
    if (!Number.isFinite(latestTimestamp) || latestTimestamp <= 0) {
      context.fillStyle = "#94a3b8";
      context.font = '12px "Avenir Next", sans-serif';
      context.fillText("Waiting for trace samples...", left, top + 14);
      return;
    }
    if (originRef.current === null || latestTimestamp < originRef.current) {
      originRef.current = latestTimestamp;
    }
    const origin = originRef.current;
    const minTs = latestTimestamp - windowNs;
    const recent = filtered.filter((sample) => sample.timestamp >= minTs);

    const xOf = (timestamp: number): number => {
      const delta = timestamp - origin;
      const wrapped = ((delta % windowNs) + windowNs) % windowNs;
      return left + (wrapped / windowNs) * plotWidth;
    };
    const yFromMs = (valueMs: number, maxMs: number): number => {
      const ratio = clamp(valueMs / Math.max(maxMs, 1e-9), 0, 1);
      return plotBottom - ratio * (plotBottom - plotTop);
    };

    context.strokeStyle = "#1e293b";
    context.lineWidth = 1;
    const tickCount = Math.max(2, Math.floor(windowSeconds / 0.5));
    for (let i = 0; i <= tickCount; i += 1) {
      const x = left + (i / tickCount) * plotWidth;
      context.beginPath();
      context.moveTo(x, top);
      context.lineTo(x, top + plotHeight);
      context.stroke();
    }
    const yTickCount = 4;
    for (let i = 0; i <= yTickCount; i += 1) {
      const y = plotBottom - (i / yTickCount) * (plotBottom - plotTop);
      context.beginPath();
      context.moveTo(left, y);
      context.lineTo(left + plotWidth, y);
      context.stroke();
    }
    context.strokeStyle = "#334155";
    context.beginPath();
    context.moveTo(left, plotBottom);
    context.lineTo(left + plotWidth, plotBottom);
    context.stroke();

    const publisherSeries = recent
      .filter(
        (sample) =>
          sample.metric === "publish_delta_ns"
          && sample.processId === publisherProcessId
          && sample.endpointId === publisherEndpointId
      )
      .sort((a, b) => a.timestamp - b.timestamp);
    const publishTimestampBySeq = new Map<number, number>();
    for (const sample of publisherSeries) {
      if (typeof sample.sampleSeq === "number") {
        publishTimestampBySeq.set(sample.sampleSeq, sample.timestamp);
      }
    }

    const leaseSeries = recent.filter((sample) => sample.metric === "lease_time_ns");
    const attributableSeries = recent.filter(
      (sample) => sample.metric === "attributable_backpressure_ns"
    );

    const leaseSeriesByEndpoint = new Map<string, TracePoint[]>();
    for (const sample of leaseSeries) {
      const alignedTimestamp =
        typeof sample.sampleSeq === "number"
          ? (publishTimestampBySeq.get(sample.sampleSeq) ?? sample.timestamp)
          : sample.timestamp;
      if (alignedTimestamp < minTs || alignedTimestamp > latestTimestamp) {
        continue;
      }
      const point: TracePoint = {
        timestamp: alignedTimestamp,
        valueMs: toMs(sample.value),
      };
      const endpointSeries = leaseSeriesByEndpoint.get(sample.endpointId);
      if (endpointSeries) {
        endpointSeries.push(point);
      } else {
        leaseSeriesByEndpoint.set(sample.endpointId, [point]);
      }
    }
    for (const endpointSeries of leaseSeriesByEndpoint.values()) {
      endpointSeries.sort((a, b) => a.timestamp - b.timestamp);
    }
    const attributablePoints: TracePoint[] = [];
    for (const sample of attributableSeries) {
      const alignedTimestamp =
        typeof sample.sampleSeq === "number"
          ? (publishTimestampBySeq.get(sample.sampleSeq) ?? sample.timestamp)
          : sample.timestamp;
      if (alignedTimestamp < minTs || alignedTimestamp > latestTimestamp) {
        continue;
      }
      attributablePoints.push({
        timestamp: alignedTimestamp,
        valueMs: toMs(sample.value),
      });
    }
    attributablePoints.sort((a, b) => a.timestamp - b.timestamp);
    const publisherPoints: TracePoint[] = publisherSeries.map((sample) => ({
      timestamp: sample.timestamp,
      valueMs: toMs(sample.value),
    }));
    const leasePoints = [...leaseSeriesByEndpoint.values()].flat();

    const maxObservedMs = Math.max(
      MIN_Y_MAX_MS,
      ...publisherPoints.map((sample) => sample.valueMs),
      ...leasePoints.map((sample) => sample.valueMs),
      ...attributablePoints.map((sample) => sample.valueMs)
    );
    let sharedYMaxMs = MIN_Y_MAX_MS;
    if (autoYAxis) {
      const target = Math.max(MIN_Y_MAX_MS, maxObservedMs * AUTO_Y_HEADROOM);
      const previous = autoYMaxMsRef.current;
      if (previous === null || target >= previous) {
        sharedYMaxMs = target;
      } else {
        sharedYMaxMs = Math.max(target, previous * AUTO_Y_DECAY);
      }
      autoYMaxMsRef.current = sharedYMaxMs;
    } else {
      sharedYMaxMs = Math.max(
        MIN_Y_MAX_MS,
        manualYMaxMs ?? DEFAULT_MANUAL_Y_MAX_MS
      );
      autoYMaxMsRef.current = sharedYMaxMs;
    }

    context.strokeStyle = ATTR_BP_COLOR;
    context.lineWidth = 1;
    context.globalAlpha = 0.5;
    const attributableBins = buildSeriesBins(attributablePoints, {
      left,
      plotWidth,
      yMaxMs: sharedYMaxMs,
      xOf,
    });
    for (let col = 0; col < attributableBins.length; col += 1) {
      const bin = attributableBins[col];
      if (!bin.hasValue) {
        continue;
      }
      const x = left + col + 0.5;
      const y = yFromMs(bin.maxMs, sharedYMaxMs);
      context.beginPath();
      context.moveTo(x, plotBottom);
      context.lineTo(x, y);
      context.stroke();
    }
    context.globalAlpha = 1;

    for (const [endpointId, endpointSeries] of leaseSeriesByEndpoint.entries()) {
      context.strokeStyle = leaseColorForEndpoint(endpointId, leaseColorMap);
      context.lineWidth = 1.1;
      const bins = buildSeriesBins(endpointSeries, {
        left,
        plotWidth,
        yMaxMs: sharedYMaxMs,
        xOf,
      });
      context.beginPath();
      let started = false;
      for (let col = 0; col < bins.length; col += 1) {
        const bin = bins[col];
        const x = left + col + 0.5;
        if (!bin.hasValue) {
          if (started) {
            context.stroke();
            context.beginPath();
            started = false;
          }
          continue;
        }
        const y = yFromMs(bin.maxMs, sharedYMaxMs);
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

    context.strokeStyle = PUBLISH_COLOR;
    context.lineWidth = 1.25;
    const publishBins = buildSeriesBins(publisherPoints, {
      left,
      plotWidth,
      yMaxMs: sharedYMaxMs,
      xOf,
    });
    context.beginPath();
    let started = false;
    for (let col = 0; col < publishBins.length; col += 1) {
      const bin = publishBins[col];
      const x = left + col + 0.5;
      if (!bin.hasValue) {
        if (started) {
          context.stroke();
          context.beginPath();
          started = false;
        }
        continue;
      }
      const y = yFromMs(bin.maxMs, sharedYMaxMs);
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

    const cursorX = xOf(latestTimestamp);
    context.strokeStyle = CURSOR_COLOR;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(cursorX, top);
    context.lineTo(cursorX, top + plotHeight);
    context.stroke();

    context.fillStyle = "#cbd5e1";
    context.font = '11px "Avenir Next", sans-serif';
    context.fillText(
      `${windowSeconds.toFixed(1)}s`,
      left + plotWidth - 24,
      top + plotHeight + 16
    );
    context.fillText(`${sharedYMaxMs.toFixed(2)} ms`, 6, plotTop + 8);
    context.fillText("0 ms", 8, plotBottom + 4);
  }, [
    autoYAxis,
    filtered,
    manualYMaxMs,
    leaseColorMap,
    publisherEndpointId,
    publisherProcessId,
    windowSeconds,
  ]);

  return (
    <div className="timing-trace">
      <div className="timing-trace__controls">
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
