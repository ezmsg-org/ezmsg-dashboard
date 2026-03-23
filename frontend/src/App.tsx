import { useEffect, useMemo, useState } from "react";

import { ProfilingPanel } from "./components/ProfilingPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import {
  TopologyPanel,
  type TopologyEntitySelection,
} from "./components/TopologyPanel";
import { useDashboardData } from "./hooks/useDashboardData";

type InspectorState =
  | {
      kind: "unit";
      unitAddress: string;
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
  collectionOpenMode: "single" | "double";
  showLegend: boolean;
  showMiniMap: boolean;
};

const SETTINGS_STORAGE_KEY = "ezmsg-dashboard-global-settings";
const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  snapshotPollSeconds: 2.0,
  topologyDefaultLayout: "tb",
  collectionOpenMode: "double",
  showLegend: true,
  showMiniMap: true,
};
const CANONICAL_GRAPH_ADDRESS = "127.0.0.1:25978";

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
  return {
    snapshotPollSeconds: poll,
    topologyDefaultLayout:
      raw.topologyDefaultLayout === "lr" ? "lr" : "tb",
    collectionOpenMode:
      raw.collectionOpenMode === "single" ? "single" : "double",
    showLegend:
      typeof raw.showLegend === "boolean"
        ? raw.showLegend
        : DEFAULT_GLOBAL_SETTINGS.showLegend,
    showMiniMap:
      typeof raw.showMiniMap === "boolean"
        ? raw.showMiniMap
        : DEFAULT_GLOBAL_SETTINGS.showMiniMap,
  };
}

export function App() {
  const [inspector, setInspector] = useState<InspectorState>(null);
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false);
  const [profilingSectionOpen, setProfilingSectionOpen] = useState(true);
  const [settingsSectionOpen, setSettingsSectionOpen] = useState(true);
  const [profilingFocusActionId, setProfilingFocusActionId] = useState(0);
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

  const handleTopologySelection = (selection: TopologyEntitySelection | null) => {
    if (!selection) {
      setInspector(null);
      return;
    }
    if (selection.kind === "unit") {
      setSettingsSectionOpen(true);
      setInspector({
        kind: "unit",
        unitAddress: selection.unitAddress,
      });
      return;
    }
    if (selection.kind === "publisher") {
      const parsed = parseStreamAddress(selection.streamAddress);
      setProfilingSectionOpen(true);
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
      setProfilingSectionOpen(true);
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

  return (
    <div className="dashboard-layout">
      <aside className="dashboard-inspector dashboard-inspector--pinned">
        <header className="dashboard-inspector__header">
          <h2>Inspector</h2>
        </header>
        <div className="dashboard-inspector__body">
          <section className="inspector-section">
            <button
              type="button"
              className="inspector-section__toggle"
              onClick={() => setProfilingSectionOpen((value) => !value)}
            >
              <span>Profiling</span>
              <span>{profilingSectionOpen ? "▾" : "▸"}</span>
            </button>
            {profilingSectionOpen ? (
              <div className="inspector-section__content">
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
                />
              </div>
            ) : null}
          </section>

          <section className="inspector-section">
            <button
              type="button"
              className="inspector-section__toggle"
              onClick={() => setSettingsSectionOpen((value) => !value)}
            >
              <span>Settings</span>
              <span>{settingsSectionOpen ? "▾" : "▸"}</span>
            </button>
            {settingsSectionOpen ? (
              <div className="inspector-section__content">
                <SettingsPanel
                  settings={snapshot?.settings ?? null}
                  patchSettingField={patchSettingField}
                  focusComponentAddress={
                    inspector?.kind === "unit" ? inspector.unitAddress : null
                  }
                />
              </div>
            ) : null}
          </section>
        </div>
      </aside>

      <div className="dashboard-viewport">
        <TopologyPanel
          graphSnapshot={snapshot?.snapshot ?? null}
          recentEvents={topologyEvents}
          immersive
          showLegend={globalSettings.showLegend}
          showMiniMap={globalSettings.showMiniMap}
          defaultLayout={globalSettings.topologyDefaultLayout}
          collectionOpenMode={globalSettings.collectionOpenMode}
          onEntitySelect={handleTopologySelection}
        />

        <section className="dashboard-brand-card">
          <div className="dashboard-brand-card__title-row">
            <span className="dashboard-brand-logo mono">ez</span>
            <h1 className="mono">ezmsg-dashboard</h1>
            <button
              type="button"
              className="topology-layout-btn"
              onClick={() => setGlobalSettingsOpen(true)}
            >
              Global Settings
            </button>
          </div>
          <div className="dashboard-brand-card__status-row">
            <span className={`status-pill is-${connectionState}`}>
              WS {connectionState}
            </span>
            <span
              className={`status-pill ${
                health?.graph_session_active ? "is-open" : "is-closed"
              }`}
            >
              Session {health?.graph_session_active ? "active" : "inactive"}
            </span>
          </div>
          <div className="dashboard-brand-card__meta">
            <p className="muted">
              GraphServer:{" "}
              <span className="mono">
                {(health?.graph_address && health.graph_address.length > 0)
                  ? health.graph_address
                  : CANONICAL_GRAPH_ADDRESS}
              </span>
            </p>
            <p className="muted">
              Profiling snapshot:{" "}
              <span className="mono">
                {profilingSnapshotUpdatedMs
                  ? new Date(profilingSnapshotUpdatedMs).toLocaleTimeString()
                  : "n/a"}
              </span>
            </p>
          </div>
          {error ? <p className="error-text">{error}</p> : null}
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
                  <span>Collection Open Behavior</span>
                  <select
                    value={globalSettings.collectionOpenMode}
                    onChange={(event) =>
                      setGlobalSettings((previous) => ({
                        ...previous,
                        collectionOpenMode:
                          event.target.value === "single" ? "single" : "double",
                      }))
                    }
                  >
                    <option value="double">Double click</option>
                    <option value="single">Single click</option>
                  </select>
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
                <div className="dashboard-modal__suggestions">
                  <p>Good next global settings to add:</p>
                  <ul>
                    <li>Default trace capture TTL and metrics preset</li>
                    <li>Auto-fit behavior on scope/layout changes</li>
                    <li>Inspector width and density mode</li>
                  </ul>
                </div>
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}
