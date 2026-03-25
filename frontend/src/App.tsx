import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { ProfilingPanel } from "./components/ProfilingPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import {
  TopologyPanel,
  type TopologyEntitySelection,
} from "./components/TopologyPanel";
import { useDashboardData } from "./hooks/useDashboardData";
import { parseStreamAddress } from "./utils/streamAddress";
import ezmsgLogo from "./assets/ezmsg_logo.png";
import type { SettingsSnapshotPayload } from "./types/api";

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="4.2" fill="currentColor" />
      <path
        d="M12 2.5v2.4M12 19.1v2.4M21.5 12h-2.4M4.9 12H2.5M18.7 5.3l-1.7 1.7M7 17l-1.7 1.7M18.7 18.7 17 17M7 7 5.3 5.3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M15.6 3.2a8.9 8.9 0 1 0 5.2 15.6A9.5 9.5 0 0 1 15.6 3.2Z"
        fill="currentColor"
      />
    </svg>
  );
}

function DownArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 4.5v12.2M6.8 11.8 12 17.3l5.2-5.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function RightArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M4.5 12h12.2M11.8 6.8l5.5 5.2-5.5 5.2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

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
  themeMode: "light" | "dark";
  topologyDefaultLayout: "tb" | "lr";
  edgeConnectorStyle: "curved" | "orthogonal" | "smooth";
  showLegend: boolean;
  showMiniMap: boolean;
  traceMetricsPreset: "publish+lease+backpressure" | "publish+backpressure" | "publish";
  autoFitOnLayoutScopeChange: boolean;
  autoFocusOnInspectorSelection: boolean;
  inspectorWidthPx: number;
};

type TraceDockState = {
  active: boolean;
  topic: string;
  endpointId: string;
  status: "capturing" | "stopped" | "applying";
} | null;
type ActiveInspectorState = Exclude<InspectorState, null>;
type ComponentInspectorState =
  | Extract<ActiveInspectorState, { kind: "unit" }>
  | Extract<ActiveInspectorState, { kind: "collection" }>;

const SETTINGS_STORAGE_KEY = "ezmsg-dashboard-global-settings";
const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  snapshotPollSeconds: 2.0,
  themeMode: "light",
  topologyDefaultLayout: "lr",
  edgeConnectorStyle: "curved",
  showLegend: true,
  showMiniMap: true,
  traceMetricsPreset: "publish+lease+backpressure",
  autoFitOnLayoutScopeChange: true,
  autoFocusOnInspectorSelection: true,
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

function isCollectionComponentType(componentType: string): boolean {
  return componentType.toLowerCase().includes("collection");
}

function inspectorFromTopologySelection(
  selection: TopologyEntitySelection
): ActiveInspectorState {
  if (selection.kind === "unit") {
    return { kind: "unit", unitAddress: selection.unitAddress };
  }
  if (selection.kind === "collection") {
    return {
      kind: "collection",
      collectionAddress: selection.collectionAddress,
    };
  }
  const parsed = parseStreamAddress(selection.streamAddress);
  return {
    kind: selection.kind,
    unitAddress: selection.unitAddress,
    endpointId: parsed.endpointId,
    topic: parsed.topic,
  };
}

function inspectorFromSettingsAddress(
  address: string,
  settings: SettingsSnapshotPayload | null | undefined
): ComponentInspectorState {
  const componentType = settings?.[address]?.component_type ?? "";
  return isCollectionComponentType(componentType)
    ? { kind: "collection", collectionAddress: address }
    : { kind: "unit", unitAddress: address };
}

function settingsFocusAddressForInspector(inspector: InspectorState): string | null {
  if (inspector?.kind === "unit") {
    return inspector.unitAddress;
  }
  if (inspector?.kind === "collection") {
    return inspector.collectionAddress;
  }
  return null;
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
  const edgeConnectorStyle =
    raw.edgeConnectorStyle === "orthogonal"
    || raw.edgeConnectorStyle === "smooth"
    || raw.edgeConnectorStyle === "curved"
      ? raw.edgeConnectorStyle
      : DEFAULT_GLOBAL_SETTINGS.edgeConnectorStyle;
  return {
    snapshotPollSeconds: poll,
    themeMode: raw.themeMode === "dark" ? "dark" : "light",
    topologyDefaultLayout:
      raw.topologyDefaultLayout === "lr" ? "lr" : "tb",
    edgeConnectorStyle,
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
    autoFocusOnInspectorSelection:
      typeof raw.autoFocusOnInspectorSelection === "boolean"
        ? raw.autoFocusOnInspectorSelection
        : DEFAULT_GLOBAL_SETTINGS.autoFocusOnInspectorSelection,
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
  const [settingsSectionCollapsed, setSettingsSectionCollapsed] = useState(true);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [traceDockState, setTraceDockState] = useState<TraceDockState>(null);
  const [traceCloseSignal, setTraceCloseSignal] = useState(0);
  const [traceDockHost, setTraceDockHost] = useState<HTMLDivElement | null>(null);
  const [topologyFocusSelection, setTopologyFocusSelection] =
    useState<TopologyEntitySelection | null>(null);
  const [topologyFocusRequestId, setTopologyFocusRequestId] = useState(0);
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
    setTopologyFocusSelection(null);
    if (!selection) {
      setInspector(null);
      return;
    }
    setInspectorCollapsed(false);
    const nextInspector = inspectorFromTopologySelection(selection);
    if (nextInspector.kind === "unit" || nextInspector.kind === "collection") {
      setSettingsSectionCollapsed(false);
      setSettingsFocusActionId((previous) => previous + 1);
    } else {
      setProfilingFocusActionId((previous) => previous + 1);
    }
    setInspector(nextInspector);
  };

  const requestTopologyFocus = (selection: TopologyEntitySelection | null) => {
    setTopologyFocusSelection(selection);
    setTopologyFocusRequestId((previous) => previous + 1);
  };

  const handleCloseTraceDock = () => {
    setTraceCloseSignal((previous) => previous + 1);
    setTraceDockState(null);
  };

  return (
    <div
      className={`dashboard-layout is-comfortable ${
        inspectorCollapsed ? "is-inspector-collapsed " : ""
      }${
        globalSettings.themeMode === "dark" ? "is-dark" : ""
      }`}
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
                  hideFilters={false}
                  defaultTraceMetrics={traceMetrics}
                  traceDockHost={traceDockHost}
                  onTraceDockStateChange={setTraceDockState}
                  traceCloseSignal={traceCloseSignal}
                  onPublisherSelect={(selection) => {
                    setInspector({
                      kind: "publisher",
                      unitAddress: selection.unitAddress,
                      endpointId: selection.endpointId,
                      topic: selection.topic,
                    });
                    requestTopologyFocus({
                      kind: "publisher",
                      streamAddress: `${selection.topic}:${selection.endpointId}`,
                      unitAddress: selection.unitAddress,
                    });
                  }}
                  onSubscriberSelect={(selection) => {
                    setInspector({
                      kind: "subscriber",
                      unitAddress: selection.unitAddress,
                      endpointId: selection.endpointId,
                      topic: selection.topic,
                    });
                    requestTopologyFocus({
                      kind: "subscriber",
                      streamAddress: `${selection.topic}:${selection.endpointId}`,
                      unitAddress: selection.unitAddress,
                    });
                  }}
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
                  focusComponentAddress={settingsFocusAddressForInspector(inspector)}
                  focusActionId={settingsFocusActionId}
                  onComponentSelect={(address) => {
                    if (!address) {
                      setInspector(null);
                      return;
                    }
                    setSettingsFocusActionId((previous) => previous + 1);
                    const nextInspector = inspectorFromSettingsAddress(
                      address,
                      snapshot?.settings
                    );
                    setInspector(nextInspector);
                    requestTopologyFocus(
                      nextInspector.kind === "collection"
                        ? {
                            kind: "collection",
                            collectionAddress: nextInspector.collectionAddress,
                          }
                        : {
                            kind: "unit",
                            unitAddress: nextInspector.unitAddress,
                          }
                    );
                  }}
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
            profilingSnapshot={snapshot?.profiling ?? null}
            recentEvents={topologyEvents}
            immersive
            showLegend={globalSettings.showLegend}
            showMiniMap={globalSettings.showMiniMap}
            darkMode={globalSettings.themeMode === "dark"}
            defaultLayout={globalSettings.topologyDefaultLayout}
            edgeConnectorStyle={globalSettings.edgeConnectorStyle}
            autoFitOnLayoutScopeChange={globalSettings.autoFitOnLayoutScopeChange}
            autoFocusOnSelection={globalSettings.autoFocusOnInspectorSelection}
            focusSelection={topologyFocusSelection}
            focusRequestId={topologyFocusRequestId}
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
            </div>
            <p className="dashboard-brand-card__meta-line">
              <span className="mono">GraphServer {graphAddress}</span>
              <span>·</span>
              <span className="mono">Snapshot {snapshotTimeLabel}</span>
            </p>
          </section>
          <div className="dashboard-floating-control-dock" aria-label="Viewport shortcuts">
            <button
              type="button"
              className="topology-layout-btn dashboard-floating-shortcut-btn"
              onClick={() =>
                setGlobalSettings((previous) => ({
                  ...previous,
                  topologyDefaultLayout:
                    previous.topologyDefaultLayout === "lr" ? "tb" : "lr",
                }))
              }
              title={
                globalSettings.topologyDefaultLayout === "lr"
                  ? "Topology layout: left-to-right"
                  : "Topology layout: top-to-bottom"
              }
              aria-label={
                globalSettings.topologyDefaultLayout === "lr"
                  ? "Topology layout left-to-right"
                  : "Topology layout top-to-bottom"
              }
            >
              {globalSettings.topologyDefaultLayout === "lr" ? (
                <RightArrowIcon />
              ) : (
                <DownArrowIcon />
              )}
            </button>
            <button
              type="button"
              className="topology-layout-btn dashboard-floating-shortcut-btn"
              onClick={() =>
                setGlobalSettings((previous) => ({
                  ...previous,
                  themeMode: previous.themeMode === "dark" ? "light" : "dark",
                }))
              }
              title={
                globalSettings.themeMode === "dark"
                  ? "Theme: dark"
                  : "Theme: light"
              }
              aria-label={
                globalSettings.themeMode === "dark"
                  ? "Theme dark"
                  : "Theme light"
              }
            >
              {globalSettings.themeMode === "dark" ? <MoonIcon /> : <SunIcon />}
            </button>
            <button
              type="button"
              className="topology-layout-btn dashboard-floating-gear-btn"
              onClick={() => setGlobalSettingsOpen(true)}
              title="Global Settings"
              aria-label="Global Settings"
            >
              ⚙
            </button>
          </div>
          <button
            type="button"
            className={`topology-layout-btn dashboard-floating-inspector-btn ${
              inspectorCollapsed ? "is-collapsed" : ""
            }`.trim()}
            onClick={() => setInspectorCollapsed((previous) => !previous)}
            title={inspectorCollapsed ? "Show Inspector" : "Hide Inspector"}
            aria-label={inspectorCollapsed ? "Show Inspector" : "Hide Inspector"}
          >
            {inspectorCollapsed ? "«" : "»"}
          </button>

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
                    <span>Theme</span>
                    <select
                      value={globalSettings.themeMode}
                      onChange={(event) =>
                        setGlobalSettings((previous) => ({
                          ...previous,
                          themeMode: event.target.value === "dark" ? "dark" : "light",
                        }))
                      }
                    >
                      <option value="light">Light</option>
                      <option value="dark">Dark</option>
                    </select>
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
                    <span>Edge Connector Type</span>
                    <select
                      value={globalSettings.edgeConnectorStyle}
                      onChange={(event) =>
                        setGlobalSettings((previous) => ({
                          ...previous,
                          edgeConnectorStyle:
                            event.target.value === "orthogonal"
                            || event.target.value === "smooth"
                              ? event.target.value
                              : "curved",
                        }))
                      }
                    >
                      <option value="curved">Curved (Bezier)</option>
                      <option value="orthogonal">Orthogonal (Step)</option>
                      <option value="smooth">Smooth Step</option>
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
                      checked={globalSettings.autoFocusOnInspectorSelection}
                      onChange={(event) =>
                        setGlobalSettings((previous) => ({
                          ...previous,
                          autoFocusOnInspectorSelection: event.target.checked,
                        }))
                      }
                    />
                    <span>Auto-focus topology on inspector selection</span>
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
                <h3>Realtime Profiling Trace</h3>
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
