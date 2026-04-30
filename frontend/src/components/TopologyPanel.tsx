import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background,
  ControlButton,
  Controls,
  MiniMap,
  type ReactFlowInstance,
} from "reactflow";
import "reactflow/dist/style.css";

import { Panel } from "./Panel";
import {
  buildCollectionParentMap,
  classifyComponents,
  collectionHasVisibleChildren,
  collectionScopePath,
  rootScopeHasExternalStreamContext,
  visibleComponentAddresses,
} from "./topologyGraph";
import {
  buildFlowData,
  compactCollectionAddress,
  validateFlowData,
  type FlowData,
  type LayoutMode,
} from "./topologyFlowData";
import {
  applyActiveFlowHighlights,
  buildCanonicalStreamAliasIndex,
  deriveActiveCanonicalSourceStreams,
  deriveReachableActiveStreams,
} from "./topologyTrace";
import {
  buildComponentAddressByEndpointId,
  buildUnitStreamSelectionIndex,
  resolveComponentAddressByStreamSelection,
} from "./topologySelection";
import { useTopologyFocus } from "./useTopologyFocus";
import type { GraphSnapshotPayload, ProfilingSnapshotPayload } from "../types/api";
import type { TopologyChangedEnvelope } from "../types/events";
import { streamAddressWithoutEndpoint } from "../utils/streamAddress";

export type TopologyEntitySelection =
  | {
      kind: "unit";
      unitAddress: string;
    }
  | {
      kind: "publisher";
      streamAddress: string;
      unitAddress: string | null;
    }
  | {
      kind: "subscriber";
      streamAddress: string;
      unitAddress: string | null;
    }
  | {
      kind: "collection";
      collectionAddress: string;
    };

type TopologyPanelProps = {
  graphSnapshot: GraphSnapshotPayload | null;
  profilingSnapshot?: ProfilingSnapshotPayload | null;
  recentEvents: TopologyChangedEnvelope[];
  immersive?: boolean;
  showLegend?: boolean;
  showMiniMap?: boolean;
  darkMode?: boolean;
  defaultLayout?: LayoutMode;
  edgeConnectorStyle?: "curved" | "orthogonal" | "smooth";
  autoFitOnLayoutScopeChange?: boolean;
  autoFocusOnSelection?: boolean;
  focusSelection?: TopologyEntitySelection | null;
  focusRequestId?: number;
  onEntitySelect?: (selection: TopologyEntitySelection | null) => void;
};

function graphEdgeCount(graph: Record<string, string[]>): number {
  return Object.values(graph).reduce((total, targets) => total + targets.length, 0);
}
export function TopologyPanel({
  graphSnapshot,
  profilingSnapshot = null,
  recentEvents,
  immersive = false,
  showLegend = true,
  showMiniMap = true,
  darkMode = false,
  defaultLayout = "tb",
  edgeConnectorStyle = "curved",
  autoFitOnLayoutScopeChange = true,
  autoFocusOnSelection = true,
  focusSelection = null,
  focusRequestId = 0,
  onEntitySelect,
}: TopologyPanelProps) {
  const flowShellRef = useRef<HTMLDivElement | null>(null);
  const flowInstanceRef = useRef<ReactFlowInstance | null>(null);
  const flowCacheByScopeRef = useRef<Map<string, FlowData>>(new Map());
  const lastActiveAliasesSignatureRef = useRef<string>("");
  const autoScopeSignatureRef = useRef<string | null>(null);
  const previousPublisherTotalsRef = useRef<Map<string, number>>(new Map());
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [flowInitTick, setFlowInitTick] = useState(0);
  const [scopeCollectionAddress, setScopeCollectionAddress] = useState<string | null>(null);
  const [activePublisherStreamAliases, setActivePublisherStreamAliases] = useState<string[]>([]);
  const layoutMode: LayoutMode = defaultLayout;

  useEffect(() => {
    if (!profilingSnapshot) {
      previousPublisherTotalsRef.current = new Map();
      setActivePublisherStreamAliases([]);
      return;
    }
    const previousTotals = previousPublisherTotalsRef.current;
    const nextTotals = new Map<string, number>();
    const activeAliases = new Set<string>();
    for (const process of Object.values(profilingSnapshot)) {
      const processId = process.process_id;
      for (const publisher of Object.values(process.publishers)) {
        const total =
          typeof publisher.messages_published_total === "number"
          && Number.isFinite(publisher.messages_published_total)
            ? publisher.messages_published_total
            : 0;
        const key = `${processId}:${publisher.endpoint_id}`;
        const previous = previousTotals.get(key);
        if (previous !== undefined && total > previous) {
          activeAliases.add(`${publisher.topic}:${publisher.endpoint_id}`);
        }
        nextTotals.set(key, total);
      }
    }
    previousPublisherTotalsRef.current = nextTotals;
    const nextAliases = Array.from(activeAliases).sort();
    const nextSignature = nextAliases.join("|");
    if (nextSignature === lastActiveAliasesSignatureRef.current) {
      return;
    }
    lastActiveAliasesSignatureRef.current = nextSignature;
    setActivePublisherStreamAliases(nextAliases);
  }, [profilingSnapshot]);
  const topologyComponents = useMemo(
    () => (graphSnapshot ? classifyComponents(graphSnapshot) : null),
    [graphSnapshot]
  );
  const parentCollectionByAddress = useMemo(
    () => (topologyComponents ? buildCollectionParentMap(topologyComponents.collections) : new Map<string, string>()),
    [topologyComponents]
  );
  const scopePath = useMemo(
    () => (topologyComponents ? collectionScopePath(topologyComponents.collections, scopeCollectionAddress) : []),
    [topologyComponents, scopeCollectionAddress]
  );
  const unitStreamByAddress = useMemo(
    () => buildUnitStreamSelectionIndex(topologyComponents),
    [topologyComponents]
  );
  const componentAddressByEndpointId = useMemo(
    () => buildComponentAddressByEndpointId(topologyComponents),
    [topologyComponents]
  );
  const componentAddressByStreamSelection = useMemo(
    () =>
      (kind: "publisher" | "subscriber", streamAddress: string): string | null =>
        resolveComponentAddressByStreamSelection(topologyComponents, kind, streamAddress),
    [topologyComponents]
  );
  const canonicalStreamByAlias = useMemo(
    () => buildCanonicalStreamAliasIndex(topologyComponents),
    [topologyComponents]
  );
  const activeCanonicalSourceStreams = useMemo(
    () =>
      deriveActiveCanonicalSourceStreams(
        activePublisherStreamAliases,
        canonicalStreamByAlias
      ),
    [activePublisherStreamAliases, canonicalStreamByAlias]
  );
  const activeReachableSourceStreams = useMemo(() => {
    return deriveReachableActiveStreams(
      graphSnapshot,
      activeCanonicalSourceStreams,
      canonicalStreamByAlias
    );
  }, [activeCanonicalSourceStreams, canonicalStreamByAlias, graphSnapshot]);
  const activeScope = scopePath.length > 0 ? scopePath[scopePath.length - 1] : null;
  const openCollectionScopeByAddress = useCallback((collectionAddress: string) => {
    if (!topologyComponents?.collections.has(collectionAddress)) {
      return;
    }
    setScopeCollectionAddress(collectionAddress);
  }, [topologyComponents]);
  const goUpFromScopeCollection = useCallback((collectionAddress: string) => {
    setScopeCollectionAddress(parentCollectionByAddress.get(collectionAddress) ?? null);
  }, [parentCollectionByAddress]);
  const flowScopeKey = `${layoutMode}:${activeScope ?? "root"}`;
  const computedFlowData = useMemo(
    () =>
      graphSnapshot
        ? buildFlowData(
            graphSnapshot,
            layoutMode,
            activeScope,
            edgeConnectorStyle,
            darkMode,
            {
              openCollectionScope: openCollectionScopeByAddress,
              goUpFromScope: goUpFromScopeCollection,
            }
          )
        : { nodes: [], edges: [] },
    [
      graphSnapshot,
      layoutMode,
      activeScope,
      edgeConnectorStyle,
      darkMode,
      openCollectionScopeByAddress,
      goUpFromScopeCollection,
    ]
  );
  const flowData = useMemo(() => {
    if (computedFlowData.nodes.length === 0) {
      flowCacheByScopeRef.current.delete(flowScopeKey);
      return computedFlowData;
    }

    if (validateFlowData(computedFlowData)) {
      flowCacheByScopeRef.current.set(flowScopeKey, computedFlowData);
      return computedFlowData;
    }

    const cached = flowCacheByScopeRef.current.get(flowScopeKey);
    if (cached && cached.nodes.length > 0) {
      return cached;
    }
    return computedFlowData;
  }, [computedFlowData, flowScopeKey]);
  const renderedFlowData = useMemo(
    () => applyActiveFlowHighlights(flowData, activeReachableSourceStreams),
    [activeReachableSourceStreams, flowData]
  );
  const openCollectionScope = (nodeId: string) => {
    if (!nodeId.startsWith("collection:")) {
      return;
    }
    openCollectionScopeByAddress(nodeId.slice("collection:".length));
  };
  const selectEntityForNode = (nodeId: string) => {
    if (nodeId.startsWith("unit:")) {
      onEntitySelect?.({
        kind: "unit",
        unitAddress: nodeId.slice("unit:".length),
      });
      return;
    }
    if (nodeId.startsWith("collection:")) {
      onEntitySelect?.({
        kind: "collection",
        collectionAddress: nodeId.slice("collection:".length),
      });
      return;
    }
    if (nodeId.startsWith("stream:")) {
      const streamAddress = nodeId.slice("stream:".length);
      const meta =
        unitStreamByAddress.get(streamAddress)
        ?? unitStreamByAddress.get(streamAddressWithoutEndpoint(streamAddress));
      if (!meta) {
        onEntitySelect?.(null);
        return;
      }
      if (meta.direction === "output") {
        onEntitySelect?.({
          kind: "publisher",
          streamAddress,
          unitAddress: meta.unitAddress,
        });
        return;
      }
      if (meta.direction === "input") {
        onEntitySelect?.({
          kind: "subscriber",
          streamAddress,
          unitAddress: meta.unitAddress,
        });
        return;
      }
    }
    onEntitySelect?.(null);
  };
  useEffect(() => {
    if (!topologyComponents || !scopeCollectionAddress) {
      return;
    }
    if (!topologyComponents.collections.has(scopeCollectionAddress)) {
      setScopeCollectionAddress(null);
    }
  }, [scopeCollectionAddress, topologyComponents]);
  useEffect(() => {
    if (!topologyComponents || !graphSnapshot) {
      autoScopeSignatureRef.current = null;
      return;
    }
    const rootAddresses = visibleComponentAddresses(
      topologyComponents.units,
      topologyComponents.collections,
      null
    );
    const onlyAddress = rootAddresses.length === 1 ? rootAddresses[0] : null;
    const hasExternalRootContext =
      onlyAddress !== null
      && rootScopeHasExternalStreamContext(
        graphSnapshot,
        topologyComponents.units,
        topologyComponents.collections,
        onlyAddress
      );
    const canAutoEnter =
      onlyAddress !== null
      && topologyComponents.collections.has(onlyAddress)
      && collectionHasVisibleChildren(
        onlyAddress,
        topologyComponents.units,
        topologyComponents.collections
      )
      && !hasExternalRootContext;
    const signature = `${rootAddresses.slice().sort().join("|")}::${canAutoEnter ? "ready" : "wait"}`;
    if (autoScopeSignatureRef.current === signature) {
      return;
    }
    autoScopeSignatureRef.current = signature;
    if (scopeCollectionAddress !== null) {
      return;
    }
    if (!canAutoEnter || !onlyAddress) {
      return;
    }
    setScopeCollectionAddress(onlyAddress);
  }, [graphSnapshot, scopeCollectionAddress, topologyComponents]);

  useEffect(() => {
    if (!topologyComponents || !scopeCollectionAddress) {
      return;
    }
    const scopedVisible = visibleComponentAddresses(
      topologyComponents.units,
      topologyComponents.collections,
      scopeCollectionAddress
    );
    if (scopedVisible.length === 0) {
      setScopeCollectionAddress(null);
    }
  }, [scopeCollectionAddress, topologyComponents]);

  useTopologyFocus({
    autoFocusOnSelection,
    focusSelection,
    focusRequestId,
    flowInitTick,
    flowInstanceRef,
    flowData,
    topologyComponents,
    activeScope,
    parentCollectionByAddress,
    componentAddressByEndpointId,
    componentAddressByStreamSelection,
    setScopeCollectionAddress,
  });

  useEffect(() => {
    const handleFullscreenChange = () => {
      const host =
        (flowShellRef.current?.closest(".dashboard-layout") as HTMLElement | null)
        ?? flowShellRef.current;
      const fullscreenElement = document.fullscreenElement;
      if (!host || !fullscreenElement) {
        setIsFullscreen(false);
        return;
      }
      setIsFullscreen(
        fullscreenElement === host || fullscreenElement.contains(host)
      );
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  if (!graphSnapshot) {
    if (immersive) {
      return (
        <section className="topology-immersive">
          <div className="topology-empty-state">
            <p>Waiting for initial snapshot...</p>
          </div>
        </section>
      );
    }
    return (
      <Panel
        title="Topology"
        subtitle="Live graph, process ownership, and edge changes"
      >
        <div className="placeholder">
          <p>Waiting for initial snapshot...</p>
        </div>
      </Panel>
    );
  }

  const topicCount = Object.keys(graphSnapshot.graph).length;
  const edgeCount = graphEdgeCount(graphSnapshot.graph);
  const sessionCount = Object.keys(graphSnapshot.sessions).length;
  const processRows = Object.values(graphSnapshot.processes);
  const fullscreenHost =
    (flowShellRef.current?.closest(".dashboard-layout") as HTMLElement | null)
    ?? flowShellRef.current
    ?? document.documentElement;
  const toggleFullscreen = async () => {
    if (!fullscreenHost) {
      return;
    }
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await fullscreenHost.requestFullscreen();
      }
    } catch {
      // Ignore unsupported/fullscreen errors.
    }
  };
  const toolbarContent = (
    <div className="topology-flow-toolbar">
        <span className="topology-flow-toolbar__label">Scope</span>
        <button
          type="button"
          className={`topology-layout-btn ${activeScope ? "" : "is-active"}`}
          onClick={() => setScopeCollectionAddress(null)}
        >
          Root
        </button>
        <button
          type="button"
          className="topology-layout-btn"
          disabled={!activeScope}
          onClick={() => {
            if (!activeScope) {
              return;
            }
            setScopeCollectionAddress(parentCollectionByAddress.get(activeScope) ?? null);
          }}
        >
          Up
        </button>
        {scopePath.length > 0 ? (
          <span className="topology-scope-sep">|</span>
        ) : null}
        {scopePath.length > 0 ? (
          <span className="topology-scope-trail">
            {scopePath.map((collectionAddress, index) => {
              const collection = topologyComponents?.collections.get(collectionAddress);
              const label = collection?.name ?? compactCollectionAddress(collectionAddress);
              const scopeTitle = collection
                ? [collection.name, collection.address, collection.componentType].join("\n")
                : collectionAddress;
              const isLast = index === scopePath.length - 1;
              return (
                <span key={`scope-${collectionAddress}`} className="topology-scope-segment">
                  {isLast ? (
                    <span className="topology-scope-tail" title={scopeTitle}>
                      {label}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="topology-scope-chip"
                      title={scopeTitle}
                      onClick={() => setScopeCollectionAddress(collectionAddress)}
                    >
                      {label}
                    </button>
                  )}
                  {isLast ? null : <span className="topology-scope-slash">/</span>}
                </span>
              );
            })}
          </span>
        ) : null}
      </div>
  );
  const legendContent = (
    <div className="topology-viewport-legend" aria-label="Topology legend">
      <span className="topology-viewport-legend__title">Legend</span>
      <span className="topology-viewport-legend__item">
        <i className="topology-viewport-legend__swatch is-collection" />
        Collection
      </span>
      <span className="topology-viewport-legend__item">
        <i className="topology-viewport-legend__swatch is-input" />
        Subscriber
      </span>
      <span className="topology-viewport-legend__item">
        <i className="topology-viewport-legend__swatch is-output" />
        Publisher
      </span>
      <span className="topology-viewport-legend__item">
        <i className="topology-viewport-legend__swatch is-topic" />
        Collection Topic
      </span>
      <span className="topology-viewport-legend__item">
        <i className="topology-viewport-legend__swatch is-relay" />
        Collection Relay
      </span>
      <span className="topology-viewport-legend__item">
        <i className="topology-viewport-legend__swatch is-task" />
        Task
      </span>
    </div>
  );

  const topologyViewport = (
    <>
      {immersive ? null : toolbarContent}

      <div
        className={`topology-flow-shell ${immersive ? "is-immersive" : ""} ${
          darkMode ? "is-dark" : ""
        }`}
        ref={flowShellRef}
      >
        {immersive ? (
          <div className="topology-viewport-top-controls">{toolbarContent}</div>
        ) : null}
        {immersive && showLegend ? (
          <div className="topology-viewport-bottom-dock">{legendContent}</div>
        ) : null}
        {immersive || !showLegend ? null : legendContent}
        <ReactFlow
          key={
            autoFitOnLayoutScopeChange
              ? `topology-flow-${layoutMode}-${activeScope ?? "root"}`
              : "topology-flow-stable"
          }
          nodes={renderedFlowData.nodes}
          edges={renderedFlowData.edges}
          fitView
          fitViewOptions={{ padding: 0.18, minZoom: 0.4 }}
          minZoom={0.2}
          maxZoom={2.4}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          onInit={(instance) => {
            flowInstanceRef.current = instance;
            setFlowInitTick((previous) => previous + 1);
          }}
          onPaneClick={() => onEntitySelect?.(null)}
          onNodeClick={(event, node) => {
            if (node.id.startsWith("scope:")) {
              const target = event.target as HTMLElement | null;
              const upButton = target?.closest('[data-scope-up="true"]') as HTMLButtonElement | null;
              if (upButton) {
                if (!upButton.disabled) {
                  const collectionAddress = node.id.slice("scope:".length);
                  goUpFromScopeCollection(collectionAddress);
                }
                return;
              }
            }
            if (node.id.startsWith("collection:")) {
              const target = event.target as HTMLElement | null;
              if (target?.closest('[data-open-collection="true"]')) {
                openCollectionScope(node.id);
                return;
              }
              onEntitySelect?.({
                kind: "collection",
                collectionAddress: node.id.slice("collection:".length),
              });
              return;
            }
            selectEntityForNode(node.id);
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Background color={darkMode ? "#243244" : "#d5deea"} gap={24} />
          {showMiniMap ? (
            <MiniMap
              pannable
              zoomable
              maskColor={darkMode ? "rgba(2, 6, 23, 0.72)" : "rgba(15, 23, 42, 0.10)"}
              style={{
                background: darkMode ? "#0e1728" : "#f8fafc",
                border: darkMode ? "1px solid #334155" : "1px solid #dbe2ea",
                borderRadius: 8,
              }}
              nodeColor={(node) => {
                if (node.id.startsWith("collection:")) {
                  return darkMode ? "#1d4f79" : "#dbeafe";
                }
                if (node.id.startsWith("unit:")) {
                  return darkMode ? "#1e3a62" : "#bfdbfe";
                }
                return darkMode ? "#334155" : "#cbd5e1";
              }}
            />
          ) : null}
          <Controls showFitView={false} showInteractive={false}>
            <ControlButton
              className="topology-control-btn"
              title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              onClick={() => {
                void toggleFullscreen();
              }}
            >
              ⛶
            </ControlButton>
          </Controls>
        </ReactFlow>
      </div>
    </>
  );

  if (immersive) {
    return <section className="topology-immersive">{topologyViewport}</section>;
  }

  return (
    <Panel
      title="Topology"
      subtitle="Low-level publisher/subscriber wiring with optional metadata overlays"
    >
      <div className="stats-grid">
        <article className="stat-card">
          <span>Topics</span>
          <strong>{topicCount}</strong>
        </article>
        <article className="stat-card">
          <span>Edges</span>
          <strong>{edgeCount}</strong>
        </article>
        <article className="stat-card">
          <span>Sessions</span>
          <strong>{sessionCount}</strong>
        </article>
        <article className="stat-card">
          <span>Processes</span>
          <strong>{processRows.length}</strong>
        </article>
      </div>
      {topologyViewport}

      <div className="panel-section">
        <h3>Process Ownership</h3>
        {processRows.length === 0 ? (
          <p className="muted">No process ownership in current snapshot.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Process ID</th>
                <th>PID</th>
                <th>Host</th>
                <th>Units</th>
              </tr>
            </thead>
            <tbody>
              {processRows.map((process) => (
                <tr key={process.process_id}>
                  <td className="mono">{process.process_id.slice(0, 8)}</td>
                  <td>{process.pid ?? "-"}</td>
                  <td>{process.host ?? "-"}</td>
                  <td>{process.units.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel-section">
        <h3>Recent Topology Changes</h3>
        {recentEvents.length === 0 ? (
          <p className="muted">No topology events received yet.</p>
        ) : (
          <ul className="event-list">
            {recentEvents.slice(0, 8).map((event) => (
              <li key={`topo-${event.data.seq}`} className="event-item">
                <span className="event-pill">{event.data.event_type}</span>
                <span className="mono">seq {event.data.seq}</span>
                <span>
                  {event.data.changed_topics.length > 0
                    ? event.data.changed_topics.join(", ")
                    : "No topic list"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
