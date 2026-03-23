import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { ProfilingPanel } from "./components/ProfilingPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import {
  TopologyPanel,
  type TopologyEntitySelection,
} from "./components/TopologyPanel";
import { useDashboardData } from "./hooks/useDashboardData";
import ezmsgLogo from "./assets/ezmsg_logo.png";

type InspectorState =
  | {
      kind: "unit";
      unitAddress: string;
    }
  | {
      kind: "collection";
      collectionAddress: string;
    }
  | {
      kind: "publisher";
      unitAddress: string | null;
      endpointId: string | null;
      topic: string | null;
    }
  | {
      kind: "subscriber";
      unitAddress: string | null;
      endpointId: string | null;
      topic: string | null;
    }
  | null;

type GlobalSettings = {
  snapshotPollSeconds: number;
  topologyDefaultLayout: "tb" | "lr";
  showLegend: boolean;
  showMiniMap: boolean;
  traceMetricsPreset: "publish+lease+backpressure" | "publish+backpressure" | "publish";
  autoFitOnLayoutScopeChange: boolean;
  inspectorWidthPx: number;
};

type TraceDockState = {
  active: boolean;
  topic: string;
  endpointId: string;
  status: "capturing" | "stopped" | "applying";
} | null;

const SETTINGS_STORAGE_KEY = "ezmsg-dashboard-global-settings";
const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  snapshotPollSeconds: 2.0,
  topologyDefaultLayout: "tb",
  showLegend: true,
  showMiniMap: true,
  traceMetricsPreset: "publish+lease+backpressure",
  autoFitOnLayoutScopeChange: true,
  inspectorWidthPx: 500,
};
const CANONICAL_GRAPH_ADDRESS = "127.0.0.1:25978";
type HealthTone = "ok" | "warn" | "err";

function toEpochMillis(timestamp: number): number | null {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }
  if (timestamp >= 946_684_800_000 && timestamp <= 4_102_444_800_000) {
    return timestamp;
  }
  if (timestamp >= 946_684_800 && timestamp <= 4_102_444_800) {
    return timestamp * 1000;
  }
  return null;
}

function parseStreamAddress(
  streamAddress: string
): { topic: string | null; endpointId: string | null } {
  const [topic, ...endpointParts] = streamAddress.split(":");
  return {
    topic: topic?.length ? topic : null,
    endpointId: endpointParts.length > 0 ? endpointParts.join(":") : null,
  };
}

function normalizeGlobalSettings(value: unknown): GlobalSettings {
  if (!value || typeof value !== "object") {
    return DEFAULT_GLOBAL_SETTINGS;
  }
  const raw = value as Record<string, unknown>;
  const poll =
    typeof raw.snapshotPollSeconds === "number" && Number.isFinite(raw.snapshotPollSeconds)
      ? Math.min(30, Math.max(0.5, raw.snapshotPollSeconds))
      : DEFAULT_GLOBAL_SETTINGS.snapshotPollSeconds;
  const inspectorWidthPx =
    typeof raw.inspectorWidthPx === "number" && Number.isFinite(raw.inspectorWidthPx)
      ? Math.min(900, Math.max(360, Math.round(raw.inspectorWidthPx)))
      : DEFAULT_GLOBAL_SETTINGS.inspectorWidthPx;
  const traceMetricsPreset =
    raw.traceMetricsPreset === "publish+backpressure"
    || raw.traceMetricsPreset === "publish"
    || raw.traceMetricsPreset === "publish+lease+backpressure"
      ? raw.traceMetricsPreset
      : DEFAULT_GLOBAL_SETTINGS.traceMetricsPreset;
  return {
    snapshotPollSeconds: poll,
    topologyDefaultLayout:
      raw.topologyDefaultLayout === "lr" ? "lr" : "tb",
    showLegend:
      typeof raw.showLegend === "boolean"
        ? raw.showLegend
        : DEFAULT_GLOBAL_SETTINGS.showLegend,
    showMiniMap:
      typeof raw.showMiniMap === "boolean"
        ? raw.showMiniMap
        : DEFAULT_GLOBAL_SETTINGS.showMiniMap,
    traceMetricsPreset,
    autoFitOnLayoutScopeChange:
      typeof raw.autoFitOnLayoutScopeChange === "boolean"
        ? raw.autoFitOnLayoutScopeChange
        : DEFAULT_GLOBAL_SETTINGS.autoFitOnLayoutScopeChange,
    inspectorWidthPx,
  };
}

function healthToneAndTooltip(
  connectionState: "connecting" | "open" | "closed",
  graphSessionActive: boolean | null,
  error: string | null
): { tone: HealthTone; tooltip: string } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (connectionState === "closed") {
    problems.push("WebSocket disconnected");
  } else if (connectionState === "connecting") {
    warnings.push("WebSocket connecting");
  }
  if (graphSessionActive === null) {
    warnings.push("Graph health pending");
  } else if (!graphSessionActive) {
    problems.push("Graph session inactive");
  }
  if (error) {
    problems.push(error);
  }
  if (problems.length > 0) {
    return { tone: "err", tooltip: problems.join(" · ") };
  }
  if (warnings.length > 0) {
    return { tone: "warn", tooltip: warnings.join(" · ") };
  }
  return {
    tone: "ok",
    tooltip: "Connected: GraphServer reachable, WebSocket open, session active.",
  };
}

export function App() {
  const [inspector, setInspector] = useState<InspectorState>(null);
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  const [profilingFocusActionId, setProfilingFocusActionId] = useState(0);
  const [settingsFocusActionId, setSettingsFocusActionId] = useState(0);
  const [settingsSectionCollapsed, setSettingsSectionCollapsed] = useState(false);
  const [traceDockState, setTraceDockState] = useState<TraceDockState>(null);
  const [traceCloseSignal, setTraceCloseSignal] = useState(0);
  const [traceDockHost, setTraceDockHost] = useState<HTMLDivElement | null>(null);
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings>(() => {
    try {
      const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) {
        return DEFAULT_GLOBAL_SETTINGS;
      }
      return normalizeGlobalSettings(JSON.parse(raw) as unknown);
    } catch {
      return DEFAULT_GLOBAL_SETTINGS;
    }
  });

  useEffect(() => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify(globalSettings)
    );
  }, [globalSettings]);

  const {
    health,
    snapshot,
    latestTraceEvent,
    connectionState,
    error,
    lastSnapshotUpdateMs,
    topologyEvents,
    patchSettingField,
    setProfilingTraceControl,
  } = useDashboardData({
    snapshotPollSeconds: globalSettings.snapshotPollSeconds,
  });

  const profilingSnapshotUpdatedMs = useMemo(() => {
    let latestTimestamp = 0;
    for (const processSnapshot of Object.values(snapshot?.profiling ?? {})) {
      if (
        typeof processSnapshot.timestamp === "number"
        && Number.isFinite(processSnapshot.timestamp)
      ) {
        const epochMs = toEpochMillis(processSnapshot.timestamp);
        if (epochMs !== null) {
          latestTimestamp = Math.max(latestTimestamp, epochMs);
        }
      }
    }
    if (latestTimestamp <= 0) {
      return lastSnapshotUpdateMs;
    }
    return latestTimestamp;
  }, [lastSnapshotUpdateMs, snapshot?.profiling]);
  const graphAddress = (health?.graph_address && health.graph_address.length > 0)
    ? health.graph_address
    : CANONICAL_GRAPH_ADDRESS;
  const snapshotTimeLabel = profilingSnapshotUpdatedMs
    ? new Date(profilingSnapshotUpdatedMs).toLocaleTimeString()
    : "n/a";
  const healthStatus = useMemo(
    () =>
      healthToneAndTooltip(
        connectionState,
        health?.graph_session_active ?? null,
        error
      ),
    [connectionState, health?.graph_session_active, error]
  );
  const traceMetrics = useMemo(() => {
    if (globalSettings.traceMetricsPreset === "publish") {
      return ["publish_delta_ns"];
    }
    if (globalSettings.traceMetricsPreset === "publish+backpressure") {
      return ["publish_delta_ns", "attributable_backpressure_ns"];
    }
    return ["publish_delta_ns", "lease_time_ns", "attributable_backpressure_ns"];
  }, [globalSettings.traceMetricsPreset]);
  const dashboardLayoutStyle = useMemo(
    () =>
      ({
        "--inspector-width": `${globalSettings.inspectorWidthPx}px`,
      }) as CSSProperties,
    [globalSettings.inspectorWidthPx]
  );

  const handleTopologySelection = (selection: TopologyEntitySelection | null) => {
    if (!selection) {
      setInspector(null);
      return;
    }
    if (selection.kind === "unit") {
      setSettingsSectionCollapsed(false);
      setSettingsFocusActionId((previous) => previous + 1);
      setInspector({
        kind: "unit",
        unitAddress: selection.unitAddress,
      });
      return;
    }
    if (selection.kind === "collection") {
      setSettingsSectionCollapsed(false);
      setSettingsFocusActionId((previous) => previous + 1);
      setInspector({
        kind: "collection",
        collectionAddress: selection.collectionAddress,
      });
      return;
    }
    if (selection.kind === "publisher") {
      const parsed = parseStreamAddress(selection.streamAddress);
      setProfilingFocusActionId((previous) => previous + 1);
      setInspector({
        kind: "publisher",
        unitAddress: selection.unitAddress,
        endpointId: parsed.endpointId,
        topic: parsed.topic,
      });
      return;
    }
    if (selection.kind === "subscriber") {
      const parsed = parseStreamAddress(selection.streamAddress);
      setProfilingFocusActionId((previous) => previous + 1);
      setInspector({
        kind: "subscriber",
        unitAddress: selection.unitAddress,
        endpointId: parsed.endpointId,
        topic: parsed.topic,
      });
      return;
    }
    setInspector(null);
  };

  const handleCloseTraceDock = () => {
    setTraceCloseSignal((previous) => previous + 1);
    setTraceDockState(null);
  };

  return (
    <div
      className="dashboard-layout is-comfortable"
      style={dashboardLayoutStyle}
    >
      <aside className="dashboard-inspector dashboard-inspector--pinned">
        <div
          className={`dashboard-inspector__body ${
            settingsSectionCollapsed ? "is-settings-collapsed" : ""
          }`}
        >
          <section className="inspector-section inspector-section--split">
            <header className="inspector-section__header">Publishers</header>
            <div className="inspector-section__content inspector-section__content--scroll">
              <ProfilingPanel
                graphSnapshot={snapshot?.snapshot ?? null}
                profilingSnapshot={snapshot?.profiling ?? null}
                latestTraceEvent={latestTraceEvent}
                setProfilingTraceControl={setProfilingTraceControl}
                focusPublisherEndpointId={
                  inspector?.kind === "publisher" ? inspector.endpointId : null
                }
                focusPublisherTopic={
                  inspector?.kind === "publisher" ? inspector.topic : null
                }
                focusSubscriberEndpointId={
                  inspector?.kind === "subscriber" ? inspector.endpointId : null
                }
                  focusActionId={profilingFocusActionId}
                  hideFilters={
                    inspector?.kind === "publisher"
                    || inspector?.kind === "subscriber"
                  }
                  defaultTraceMetrics={traceMetrics}
                  traceDockHost={traceDockHost}
                  onTraceDockStateChange={setTraceDockState}
                  traceCloseSignal={traceCloseSignal}
                />
              </div>
          </section>

          <section className="inspector-section inspector-section--split">
            <header className="inspector-section__header">
              <span>Settings</span>
              <button
                type="button"
                className="inspector-section__collapse-btn"
                onClick={() => setSettingsSectionCollapsed((previous) => !previous)}
              >
                {settingsSectionCollapsed ? "Expand" : "Collapse"}
              </button>
            </header>
            {settingsSectionCollapsed ? null : (
              <div className="inspector-section__content inspector-section__content--scroll">
                <SettingsPanel
                  settings={snapshot?.settings ?? null}
                  patchSettingField={patchSettingField}
                  focusComponentAddress={
                    inspector?.kind === "unit"
                      ? inspector.unitAddress
                      : inspector?.kind === "collection"
                        ? inspector.collectionAddress
                        : null
                  }
                  focusActionId={settingsFocusActionId}
                />
              </div>
            )}
          </section>
        </div>
      </aside>

      <div className="dashboard-main">
        <div className="dashboard-viewport">
          <TopologyPanel
            graphSnapshot={snapshot?.snapshot ?? null}
            recentEvents={topologyEvents}
            immersive
            showLegend={globalSettings.showLegend}
            showMiniMap={globalSettings.showMiniMap}
            defaultLayout={globalSettings.topologyDefaultLayout}
            autoFitOnLayoutScopeChange={globalSettings.autoFitOnLayoutScopeChange}
            onEntitySelect={handleTopologySelection}
          />

          <section className="dashboard-brand-card">
            <span
              className={`dashboard-health-dot is-${healthStatus.tone}`}
              title={healthStatus.tooltip}
              aria-label={healthStatus.tooltip}
            />
            <img src={ezmsgLogo} alt="ezmsg" className="dashboard-brand-logo-image" />
            <div className="dashboard-brand-card__title-row">
              <h1 className="mono">ezmsg-dashboard</h1>
              <button
                type="button"
                className="topology-layout-btn dashboard-gear-btn"
                onClick={() => setGlobalSettingsOpen(true)}
                title="Global Settings"
                aria-label="Global Settings"
              >
                ⚙
              </button>
            </div>
            <p className="dashboard-brand-card__meta-line">
              <span className="mono">GraphServer {graphAddress}</span>
              <span>·</span>
              <span className="mono">Snapshot {snapshotTimeLabel}</span>
            </p>
          </section>

          {globalSettingsOpen ? (
            <div
              className="dashboard-modal-backdrop"
              onClick={() => setGlobalSettingsOpen(false)}
            >
              <section
                className="dashboard-modal"
                onClick={(event) => event.stopPropagation()}
              >
                <header className="dashboard-modal__header">
                  <h2>Global Settings</h2>
                  <button
                    type="button"
                    className="topology-layout-btn"
                    onClick={() => setGlobalSettingsOpen(false)}
                  >
                    Close
                  </button>
                </header>
                <div className="dashboard-modal__body">
                  <label className="dashboard-setting-row">
                    <span>Snapshot Poll Frequency (seconds)</span>
                    <input
                      type="number"
                      min={0.5}
                      max={30}
                      step={0.5}
                      value={globalSettings.snapshotPollSeconds}
                      onChange={(event) => {
                        const next = Number.parseFloat(event.target.value);
                        if (!Number.isFinite(next)) {
                          return;
                        }
                        setGlobalSettings((previous) => ({
                          ...previous,
                          snapshotPollSeconds: Math.max(0.5, Math.min(30, next)),
                        }));
                      }}
                    />
                  </label>
                  <label className="dashboard-setting-row">
                    <span>Default Topology Layout</span>
                    <select
                      value={globalSettings.topologyDefaultLayout}
                      onChange={(event) =>
                        setGlobalSettings((previous) => ({
                          ...previous,
                          topologyDefaultLayout:
                            event.target.value === "lr" ? "lr" : "tb",
                        }))
                      }
                    >
                      <option value="tb">Top to Bottom</option>
                      <option value="lr">Left to Right</option>
                    </select>
                  </label>
                  <label className="dashboard-setting-row">
                    <span>Default Trace Metrics</span>
                    <select
                      value={globalSettings.traceMetricsPreset}
                      onChange={(event) =>
                        setGlobalSettings((previous) => ({
                          ...previous,
                          traceMetricsPreset:
                            event.target.value === "publish"
                            || event.target.value === "publish+backpressure"
                              ? event.target.value
                              : "publish+lease+backpressure",
                        }))
                      }
                    >
                      <option value="publish+lease+backpressure">
                        Publish + Lease + Backpressure
                      </option>
                      <option value="publish+backpressure">
                        Publish + Backpressure
                      </option>
                      <option value="publish">Publish Only</option>
                    </select>
                  </label>
                  <label className="dashboard-setting-toggle">
                    <input
                      type="checkbox"
                      checked={globalSettings.autoFitOnLayoutScopeChange}
                      onChange={(event) =>
                        setGlobalSettings((previous) => ({
                          ...previous,
                          autoFitOnLayoutScopeChange: event.target.checked,
                        }))
                      }
                    />
                    <span>Auto-fit on layout/scope change</span>
                  </label>
                  <label className="dashboard-setting-row">
                    <span>Inspector Width (px)</span>
                    <input
                      type="number"
                      min={360}
                      max={900}
                      step={10}
                      value={globalSettings.inspectorWidthPx}
                      onChange={(event) => {
                        const next = Number.parseInt(event.target.value, 10);
                        if (!Number.isFinite(next)) {
                          return;
                        }
                        setGlobalSettings((previous) => ({
                          ...previous,
                          inspectorWidthPx: Math.max(360, Math.min(900, next)),
                        }));
                      }}
                    />
                  </label>
                  <label className="dashboard-setting-toggle">
                    <input
                      type="checkbox"
                      checked={globalSettings.showLegend}
                      onChange={(event) =>
                        setGlobalSettings((previous) => ({
                          ...previous,
                          showLegend: event.target.checked,
                        }))
                      }
                    />
                    <span>Show legend</span>
                  </label>
                  <label className="dashboard-setting-toggle">
                    <input
                      type="checkbox"
                      checked={globalSettings.showMiniMap}
                      onChange={(event) =>
                        setGlobalSettings((previous) => ({
                          ...previous,
                          showMiniMap: event.target.checked,
                        }))
                      }
                    />
                    <span>Show minimap</span>
                  </label>
                </div>
              </section>
            </div>
          ) : null}
        </div>

        {traceDockState?.active ? (
          <section className="trace-dock">
            <header className="trace-dock__header">
              <div className="trace-dock__title-wrap">
                <h3>Realtime Trace</h3>
              </div>
              <div className="trace-dock__actions">
                <span
                  className={`trace-status ${
                    traceDockState.status === "capturing" ? "is-live" : ""
                  }`}
                >
                  {traceDockState.status}
                </span>
                <button
                  type="button"
                  className="topology-layout-btn trace-dock__close-btn"
                  onClick={handleCloseTraceDock}
                  title="Close trace"
                  aria-label="Close trace"
                >
                  ✕
                </button>
              </div>
            </header>
            <div className="trace-dock__body">
              <div className="trace-dock__host" ref={setTraceDockHost} />
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
