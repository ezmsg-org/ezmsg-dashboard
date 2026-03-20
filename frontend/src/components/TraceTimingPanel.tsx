import { useEffect, useMemo, useRef, useState } from "react";

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
  windowSeconds?: number;
};

const PUBLISH_COLOR = "#38bdf8";
const LEASE_COLOR = "#93c5fd";
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

export function TraceTimingPanel({
  samples,
  publisherProcessId,
  publisherEndpointId,
  topic,
  topicScope,
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

    const cursorX = xOf(latestTimestamp);
    context.strokeStyle = CURSOR_COLOR;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(cursorX, top);
    context.lineTo(cursorX, top + plotHeight);
    context.stroke();

    const publisherSeries = recent
      .filter(
        (sample) =>
          sample.metric === "publish_delta_ns"
          && sample.processId === publisherProcessId
          && sample.endpointId === publisherEndpointId
      )
      .sort((a, b) => a.timestamp - b.timestamp);
    const leaseSeries = recent.filter((sample) => sample.metric === "lease_time_ns");
    const attributableSeries = recent.filter(
      (sample) => sample.metric === "attributable_backpressure_ns"
    );

    const maxObservedMs = Math.max(
      MIN_Y_MAX_MS,
      ...publisherSeries.map((sample) => toMs(sample.value)),
      ...leaseSeries.map((sample) => toMs(sample.value)),
      ...attributableSeries.map((sample) => toMs(sample.value))
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

    context.strokeStyle = PUBLISH_COLOR;
    context.lineWidth = 1.25;
    context.beginPath();
    let started = false;
    let previousX = 0;
    for (const sample of publisherSeries) {
      const x = xOf(sample.timestamp);
      const y = yFromMs(toMs(sample.value), sharedYMaxMs);
      if (!started || x < previousX) {
        if (started) {
          context.stroke();
          context.beginPath();
        }
        context.moveTo(x, y);
        started = true;
      } else {
        context.lineTo(x, y);
      }
      previousX = x;
    }
    if (started) {
      context.stroke();
    }

    context.fillStyle = LEASE_COLOR;
    for (const sample of leaseSeries) {
      const x = xOf(sample.timestamp);
      const y = yFromMs(toMs(sample.value), sharedYMaxMs);
      context.beginPath();
      context.arc(x, y, 2.2, 0, Math.PI * 2);
      context.fill();
    }

    context.strokeStyle = ATTR_BP_COLOR;
    context.lineWidth = 1;
    for (const sample of attributableSeries) {
      const x = xOf(sample.timestamp);
      const y = yFromMs(toMs(sample.value), sharedYMaxMs);
      context.beginPath();
      context.moveTo(x, plotBottom);
      context.lineTo(x, y);
      context.stroke();
    }

    context.fillStyle = "#cbd5e1";
    context.font = '11px "Avenir Next", sans-serif';
    context.fillText(
      `${windowSeconds.toFixed(1)}s`,
      left + plotWidth - 24,
      top + plotHeight + 16
    );
    context.fillText("0 ms", 8, plotBottom + 4);
    context.fillText(`Y max ${sharedYMaxMs.toFixed(2)} ms`, left, top + plotHeight + 16);
  }, [
    autoYAxis,
    filtered,
    manualYMaxMs,
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
              if (parsePositiveFloat(manualYMaxInput) === null) {
                setManualYMaxInput(`${DEFAULT_MANUAL_Y_MAX_MS.toFixed(2)}`);
              }
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
          <i style={{ background: LEASE_COLOR }} />
          Lease Delta
        </span>
        <span className="timing-trace__legend-item">
          <i style={{ background: ATTR_BP_COLOR }} />
          Attr BP
        </span>
      </div>
    </div>
  );
}
