import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { ProfilingPanel } from "./components/ProfilingPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { StreamPanel } from "./components/StreamPanel";
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
  traceMetricsPreset: "publish+lease+user" | "publish+lease" | "publish";
  autoFitOnLayoutScopeChange: boolean;
  autoFocusOnInspectorSelection: boolean;
  showSettingsChannels: boolean;
  inspectorWidthPx: number;
};

type TraceDockState = {
  active: boolean;
  topic: string;
  endpointId: string;
  status: "capturing" | "stopped" | "applying";
} | null;

/**
 * The publisher whose data is being watched.
 *
 * One at a time, deliberately: each viewer holds an open socket and a decimator
 * on the backend, and stacking several into the dock leaves none of them tall
 * enough to read.
 */
type StreamDockState = {
  topic: string;
  unitAddress: string | null;
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
  traceMetricsPreset: "publish+lease+user",
  autoFitOnLayoutScopeChange: true,
  autoFocusOnInspectorSelection: true,
  showSettingsChannels: false,
  inspectorWidthPx: 500,
};
const CANONICAL_GRAPH_ADDRESS = "127.0.0.1:25978";
const INSPECTOR_WIDTH_MIN_PX = 360;
// The topology is the point of the page, so it -- not an arbitrary ceiling --
// is what bounds how wide the inspector may get. Mirrored in the grid template,
// which keeps a stale stored width from squeezing the graph after a resize.
const TOPOLOGY_MIN_WIDTH_PX = 480;
/** How far one arrow key press moves the inspector divider. */
const INSPECTOR_WIDTH_KEY_STEP_PX = 16;
type HealthTone = "ok" | "warn" | "err";

function maxInspectorWidth(): number {
  const viewportWidth = typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth;
  return Math.max(INSPECTOR_WIDTH_MIN_PX, viewportWidth - TOPOLOGY_MIN_WIDTH_PX);
}

function clampInspectorWidth(value: number): number {
  return Math.min(maxInspectorWidth(), Math.max(INSPECTOR_WIDTH_MIN_PX, Math.round(value)));
}

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
      ? clampInspectorWidth(raw.inspectorWidthPx)
      : DEFAULT_GLOBAL_SETTINGS.inspectorWidthPx;
  const traceMetricsPreset =
    raw.traceMetricsPreset === "publish+lease"
    || raw.traceMetricsPreset === "publish"
    || raw.traceMetricsPreset === "publish+lease+user"
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
    showSettingsChannels:
      typeof raw.showSettingsChannels === "boolean"
        ? raw.showSettingsChannels
        : DEFAULT_GLOBAL_SETTINGS.showSettingsChannels,
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
  const [publishersSectionCollapsed, setPublishersSectionCollapsed] = useState(false);
  const [settingsSectionCollapsed, setSettingsSectionCollapsed] = useState(true);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [traceDockState, setTraceDockState] = useState<TraceDockState>(null);
  const [streamDockState, setStreamDockState] = useState<StreamDockState>(null);
  const [traceCloseSignal, setTraceCloseSignal] = useState(0);
  const [traceDockHost, setTraceDockHost] = useState<HTMLDivElement | null>(null);
  const [topologyFocusSelection, setTopologyFocusSelection] =
    useState<TopologyEntitySelection | null>(null);
  const [topologyFocusRequestId, setTopologyFocusRequestId] = useState(0);
  // Live width while the divider is being dragged; committed to global settings
  // on release so a drag is one localStorage write instead of one per frame.
  const [inspectorDragWidthPx, setInspectorDragWidthPx] = useState<number | null>(null);
  const inspectorDragOriginRef = useRef<{ pointerX: number; widthPx: number } | null>(
    null
  );
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
    if (globalSettings.traceMetricsPreset === "publish+lease") {
      return ["publish_delta_ns", "lease_time_ns"];
    }
    return ["publish_delta_ns", "lease_time_ns", "user_span_ns"];
  }, [globalSettings.traceMetricsPreset]);
  const inspectorWidthPx = inspectorDragWidthPx ?? globalSettings.inspectorWidthPx;
  const dashboardLayoutStyle = useMemo(
    () =>
      ({
        "--inspector-width": `${inspectorWidthPx}px`,
      }) as CSSProperties,
    [inspectorWidthPx]
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
      if (nextInspector.kind === "unit") {
        // Point the publishers list at the same unit. The section is left as
        // the user set it; the panel picks the request up when it is expanded.
        setProfilingFocusActionId((previous) => previous + 1);
      }
    } else {
      setPublishersSectionCollapsed(false);
      setProfilingFocusActionId((previous) => previous + 1);
    }
    setInspector(nextInspector);
  };

  const requestTopologyFocus = (selection: TopologyEntitySelection | null) => {
    setTopologyFocusSelection(selection);
    setTopologyFocusRequestId((previous) => previous + 1);
  };

  const commitInspectorWidth = (widthPx: number) => {
    setGlobalSettings((previous) => ({
      ...previous,
      inspectorWidthPx: clampInspectorWidth(widthPx),
    }));
  };

  const handleInspectorResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    inspectorDragOriginRef.current = {
      pointerX: event.clientX,
      widthPx: globalSettings.inspectorWidthPx,
    };
    setInspectorDragWidthPx(globalSettings.inspectorWidthPx);
  };

  const handleInspectorResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = inspectorDragOriginRef.current;
    if (!origin) {
      return;
    }
    // The inspector is on the right, so dragging left widens it.
    setInspectorDragWidthPx(
      clampInspectorWidth(origin.widthPx + (origin.pointerX - event.clientX))
    );
  };

  const handleInspectorResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!inspectorDragOriginRef.current) {
      return;
    }
    inspectorDragOriginRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (inspectorDragWidthPx !== null) {
      commitInspectorWidth(inspectorDragWidthPx);
    }
    setInspectorDragWidthPx(null);
  };

  const handleInspectorResizeKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>
  ) => {
    const step =
      event.key === "ArrowLeft"
        ? INSPECTOR_WIDTH_KEY_STEP_PX
        : event.key === "ArrowRight"
          ? -INSPECTOR_WIDTH_KEY_STEP_PX
          : 0;
    if (step !== 0) {
      event.preventDefault();
      commitInspectorWidth(globalSettings.inspectorWidthPx + step);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      commitInspectorWidth(
        event.key === "Home" ? maxInspectorWidth() : INSPECTOR_WIDTH_MIN_PX
      );
    }
  };

  const handleCloseTraceDock = () => {
    setTraceCloseSignal((previous) => previous + 1);
    setTraceDockState(null);
  };

  const streamTapAvailability = health?.stream_tap ?? null;
  const streamTapDisabledReason = !streamTapAvailability
    ? "This dashboard backend does not support live data streaming."
    : streamTapAvailability.plotting
      ? null
      : (streamTapAvailability.reason
        ?? "Live data plotting is unavailable on this backend.");

  // What profiling says the streamed publisher is sending. The stream panel
  // uses it to tell a quiet topic apart from one whose messages the dashboard
  // cannot decode — the two are otherwise indistinguishable from the tap alone.
  const streamPublisherRateHz = useMemo(() => {
    const streamedTopic = streamDockState?.topic;
    if (!streamedTopic) {
      return null;
    }
    for (const processSnapshot of Object.values(snapshot?.profiling ?? {})) {
      for (const publisher of Object.values(processSnapshot.publishers ?? {})) {
        if (publisher.topic === streamedTopic) {
          return publisher.publish_rate_hz_window;
        }
      }
    }
    return null;
  }, [snapshot?.profiling, streamDockState?.topic]);

  const handleVisualizeStream = (selection: {
    unitAddress: string | null;
    topic: string;
  }) => {
    // The same button closes the viewer it opened, so the control reads as a
    // toggle rather than as an action with no visible inverse.
    setStreamDockState((previous) =>
      previous?.topic === selection.topic
        ? null
        : { topic: selection.topic, unitAddress: selection.unitAddress }
    );
  };

  const togglePublishersSection = () => {
    if (publishersSectionCollapsed) {
      setPublishersSectionCollapsed(false);
      return;
    }
    if (settingsSectionCollapsed) {
      setPublishersSectionCollapsed(true);
      setSettingsSectionCollapsed(false);
      return;
    }
    setPublishersSectionCollapsed(true);
  };

  const toggleSettingsSection = () => {
    if (settingsSectionCollapsed) {
      setSettingsSectionCollapsed(false);
      return;
    }
    if (publishersSectionCollapsed) {
      setSettingsSectionCollapsed(true);
      setPublishersSectionCollapsed(false);
      return;
    }
    setSettingsSectionCollapsed(true);
  };

  return (
    <div
      className={`dashboard-layout is-comfortable ${
        inspectorCollapsed ? "is-inspector-collapsed " : ""
      }${inspectorDragWidthPx === null ? "" : "is-resizing-inspector "}${
        globalSettings.themeMode === "dark" ? "is-dark" : ""
      }`}
      style={dashboardLayoutStyle}
    >
      <aside className="dashboard-inspector dashboard-inspector--pinned">
        {inspectorCollapsed ? null : (
          <div
            className="inspector-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize inspector"
            aria-valuemin={INSPECTOR_WIDTH_MIN_PX}
            aria-valuemax={maxInspectorWidth()}
            aria-valuenow={inspectorWidthPx}
            tabIndex={0}
            onPointerDown={handleInspectorResizeStart}
            onPointerMove={handleInspectorResizeMove}
            onPointerUp={handleInspectorResizeEnd}
            onPointerCancel={handleInspectorResizeEnd}
            onKeyDown={handleInspectorResizeKeyDown}
            onDoubleClick={() =>
              commitInspectorWidth(DEFAULT_GLOBAL_SETTINGS.inspectorWidthPx)
            }
          />
        )}
        <div
          className={`dashboard-inspector__body ${
            publishersSectionCollapsed ? "is-publishers-collapsed " : ""
          }${settingsSectionCollapsed ? "is-settings-collapsed" : ""}`}
        >
          <section className="inspector-section inspector-section--split">
            <header className="inspector-section__header">
              <span>Publishers</span>
              <button
                type="button"
                className="inspector-section__collapse-btn"
                onClick={togglePublishersSection}
              >
                {publishersSectionCollapsed ? "Expand" : "Collapse"}
              </button>
            </header>
            {publishersSectionCollapsed ? null : (
              <div className="inspector-section__content inspector-section__content--scroll">
                <ProfilingPanel
                  graphSnapshot={snapshot?.snapshot ?? null}
                  profilingSnapshot={snapshot?.profiling ?? null}
                  latestTraceEvent={latestTraceEvent}
                  setProfilingTraceControl={setProfilingTraceControl}
                  darkMode={globalSettings.themeMode === "dark"}
                  focusPublisherEndpointId={
                    inspector?.kind === "publisher" ? inspector.endpointId : null
                  }
                  focusPublisherTopic={
                    inspector?.kind === "publisher" ? inspector.topic : null
                  }
                  focusSubscriberEndpointId={
                    inspector?.kind === "subscriber" ? inspector.endpointId : null
                  }
                  focusUnitAddress={
                    inspector?.kind === "unit" ? inspector.unitAddress : null
                  }
                  focusActionId={profilingFocusActionId}
                  showSettingsChannels={globalSettings.showSettingsChannels}
                  hideFilters={false}
                  defaultTraceMetrics={traceMetrics}
                  traceDockHost={traceDockHost}
                  onTraceDockStateChange={setTraceDockState}
                  traceCloseSignal={traceCloseSignal}
                  onVisualizeStream={handleVisualizeStream}
                  visualizedTopic={streamDockState?.topic ?? null}
                  streamTapDisabledReason={streamTapDisabledReason}
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
            )}
          </section>

          <section className="inspector-section inspector-section--split">
            <header className="inspector-section__header">
              <span>Settings</span>
              <button
                type="button"
                className="inspector-section__collapse-btn"
                onClick={toggleSettingsSection}
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
                            || event.target.value === "publish+lease"
                              ? event.target.value
                              : "publish+lease+user",
                        }))
                      }
                    >
                      <option value="publish+lease+user">
                        Publish + Lease + User
                      </option>
                      <option value="publish+lease">
                        Publish + Lease
                      </option>
                      <option value="publish">Publish Only</option>
                    </select>
                  </label>
                  <label className="dashboard-setting-row">
                    <span>Inspector Width (px)</span>
                    <input
                      type="number"
                      min={INSPECTOR_WIDTH_MIN_PX}
                      max={maxInspectorWidth()}
                      step={10}
                      value={globalSettings.inspectorWidthPx}
                      onChange={(event) => {
                        const next = Number.parseInt(event.target.value, 10);
                        if (!Number.isFinite(next)) {
                          return;
                        }
                        setGlobalSettings((previous) => ({
                          ...previous,
                          inspectorWidthPx: clampInspectorWidth(next),
                        }));
                      }}
                    />
                  </label>
                  <label className="dashboard-setting-toggle">
                    <input
                      type="checkbox"
                      checked={globalSettings.showSettingsChannels}
                      onChange={(event) =>
                        setGlobalSettings((previous) => ({
                          ...previous,
                          showSettingsChannels: event.target.checked,
                        }))
                      }
                    />
                    <span>Show settings channels in Publishers (debug)</span>
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

        {streamDockState ? (
          <StreamPanel
            // Keyed by topic so switching publishers rebuilds the renderer and
            // its socket instead of feeding a new stream into the old plot's
            // geometry.
            key={streamDockState.topic}
            topic={streamDockState.topic}
            unitAddress={streamDockState.unitAddress}
            darkMode={globalSettings.themeMode === "dark"}
            availability={streamTapAvailability}
            publisherRateHz={streamPublisherRateHz}
            onClose={() => setStreamDockState(null)}
          />
        ) : null}

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
