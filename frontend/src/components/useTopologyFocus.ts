import { useEffect, useRef, type MutableRefObject } from "react";
import type { ReactFlowInstance } from "reactflow";

import {
  FOCUS_VIEW_DURATION_MS,
  FOCUS_VIEW_MAX_ZOOM,
  FOCUS_VIEW_MIN_ZOOM,
  FOCUS_VIEW_PADDING,
} from "./topologyLayout";
import type { CollectionComponent, UnitComponent } from "./topologyGraph";
import type { FlowData } from "./topologyFlowData";

type FocusSelection =
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

type TopologyComponents = {
  units: Map<string, UnitComponent>;
  collections: Map<string, CollectionComponent>;
};

type UseTopologyFocusOptions = {
  autoFocusOnSelection: boolean;
  focusSelection: FocusSelection | null;
  focusRequestId: number;
  flowInitTick: number;
  flowInstanceRef: MutableRefObject<ReactFlowInstance | null>;
  flowData: FlowData;
  topologyComponents: TopologyComponents | null;
  activeScope: string | null;
  parentCollectionByAddress: Map<string, string>;
  componentAddressByEndpointId: Map<string, string>;
  componentAddressByStreamSelection: (
    kind: "publisher" | "subscriber",
    streamAddress: string
  ) => string | null;
  setScopeCollectionAddress: (value: string | null) => void;
};

export function inferFocusComponentAddress(
  focusSelection: FocusSelection,
  componentAddressByEndpointId: Map<string, string>,
  componentAddressByStreamSelection: (
    kind: "publisher" | "subscriber",
    streamAddress: string
  ) => string | null
): string | null {
  if (focusSelection.kind !== "publisher" && focusSelection.kind !== "subscriber") {
    return null;
  }
  const streamEndpointId = focusSelection.streamAddress.split(":").slice(1).join(":");
  return (
    focusSelection.unitAddress
    ?? componentAddressByEndpointId.get(streamEndpointId)
    ?? componentAddressByStreamSelection(
      focusSelection.kind,
      focusSelection.streamAddress
    )
    ?? null
  );
}

export function resolveFocusNodeId(
  focusSelection: FocusSelection,
  inferredComponentAddress: string | null,
  flowData: FlowData,
  topologyComponents: TopologyComponents | null
): string | null {
  if (focusSelection.kind === "unit") {
    return `unit:${focusSelection.unitAddress}`;
  }
  if (focusSelection.kind === "collection") {
    return `collection:${focusSelection.collectionAddress}`;
  }
  if (inferredComponentAddress && topologyComponents?.units.has(inferredComponentAddress)) {
    return `unit:${inferredComponentAddress}`;
  }
  if (inferredComponentAddress && topologyComponents?.collections.has(inferredComponentAddress)) {
    return `collection:${inferredComponentAddress}`;
  }

  const streamAddress = focusSelection.streamAddress;
  if (!streamAddress) {
    return null;
  }
  const endpointId = streamAddress.split(":").slice(1).join(":");
  const topic = streamAddress.split(":")[0] ?? "";
  const matchedStreamNode = flowData.nodes.find((node) => {
    if (!node.id.startsWith("stream:")) {
      return false;
    }
    const address = node.id.slice("stream:".length);
    return address.includes(endpointId) || address.startsWith(topic);
  });
  return matchedStreamNode?.id ?? null;
}

export function useTopologyFocus({
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
}: UseTopologyFocusOptions) {
  const lastHandledFocusRequestRef = useRef<number>(0);
  const pendingScopeFocusRequestRef = useRef<number | null>(null);
  const scheduledFocusRequestRef = useRef<number | null>(null);

  useEffect(() => {
    if (!autoFocusOnSelection || !focusSelection || focusRequestId <= 0) {
      return;
    }
    if (lastHandledFocusRequestRef.current === focusRequestId) {
      return;
    }
    const instance = flowInstanceRef.current;
    if (!instance) {
      return;
    }

    const inferredComponentAddress = inferFocusComponentAddress(
      focusSelection,
      componentAddressByEndpointId,
      componentAddressByStreamSelection
    );
    const selectedAddress =
      focusSelection.kind === "unit"
        ? focusSelection.unitAddress
        : focusSelection.kind === "collection"
          ? focusSelection.collectionAddress
          : inferredComponentAddress;
    if (selectedAddress && topologyComponents) {
      const desiredScope = parentCollectionByAddress.get(selectedAddress) ?? null;
      if (desiredScope !== activeScope) {
        pendingScopeFocusRequestRef.current = focusRequestId;
        setScopeCollectionAddress(desiredScope);
        return;
      }
    }

    const nodeId = resolveFocusNodeId(
      focusSelection,
      inferredComponentAddress,
      flowData,
      topologyComponents
    );
    if (!nodeId || !flowData.nodes.some((node) => node.id === nodeId)) {
      return;
    }

    const runFocus = () => {
      const latestInstance = flowInstanceRef.current;
      if (!latestInstance) {
        scheduledFocusRequestRef.current = null;
        return;
      }
      latestInstance.fitView({
        nodes: [{ id: nodeId }],
        padding: FOCUS_VIEW_PADDING,
        duration: FOCUS_VIEW_DURATION_MS,
        minZoom: FOCUS_VIEW_MIN_ZOOM,
        maxZoom: FOCUS_VIEW_MAX_ZOOM,
      });
      lastHandledFocusRequestRef.current = focusRequestId;
      pendingScopeFocusRequestRef.current = null;
      scheduledFocusRequestRef.current = null;
    };

    const shouldDefer = pendingScopeFocusRequestRef.current === focusRequestId;
    if (shouldDefer) {
      if (scheduledFocusRequestRef.current === focusRequestId) {
        return;
      }
      scheduledFocusRequestRef.current = focusRequestId;
      requestAnimationFrame(() => {
        requestAnimationFrame(runFocus);
      });
      return;
    }

    runFocus();
  }, [
    activeScope,
    autoFocusOnSelection,
    componentAddressByEndpointId,
    componentAddressByStreamSelection,
    flowData,
    flowInitTick,
    focusRequestId,
    focusSelection,
    flowInstanceRef,
    parentCollectionByAddress,
    setScopeCollectionAddress,
    topologyComponents,
  ]);
}
