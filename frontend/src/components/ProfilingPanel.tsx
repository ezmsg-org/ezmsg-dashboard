import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Panel } from "./Panel";
import { TraceTimingPanel, type TimingTraceSample } from "./TraceTimingPanel";
import { buildRelayAliasIndex, classifyComponents } from "./topologyGraph";
import { buildLeaseColorMap, leaseColorForEndpoint } from "../utils/traceColors";
import {
  endpointIdFromStreamAddress,
  parseTopicAndEndpoint,
  streamAddressWithoutEndpoint,
} from "../utils/streamAddress";
import { isSettingsChannelTopic } from "../utils/settingsChannel";
import type {
  GraphSnapshotPayload,
  ProfilingTraceControlRequest,
  ProcessProfilingSnapshotPayload,
  ProfilingSnapshotPayload,
  PublisherProfilingSnapshot,
  SubscriberProfilingSnapshot,
} from "../types/api";
import type { ProfilingTraceEnvelope } from "../types/events";

type ProfilingPanelProps = {
  graphSnapshot: GraphSnapshotPayload | null;
  profilingSnapshot: ProfilingSnapshotPayload | null;
  latestTraceEvent: ProfilingTraceEnvelope | null;
  setProfilingTraceControl: (
    request: ProfilingTraceControlRequest
  ) => Promise<unknown>;
  focusPublisherEndpointId?: string | null;
  focusPublisherTopic?: string | null;
  focusSubscriberEndpointId?: string | null;
  /** Component address to focus when a whole unit is selected rather than one stream. */
  focusUnitAddress?: string | null;
  focusActionId?: number;
  /** Show control-plane INPUT_SETTINGS publishers (hidden by default). */
  showSettingsChannels?: boolean;
  hideFilters?: boolean;
  defaultTraceMetrics?: string[];
  traceDockHost?: HTMLElement | null;
  onTraceDockStateChange?: (state: {
    active: boolean;
    topic: string;
    endpointId: string;
    status: "capturing" | "stopped" | "applying";
  } | null) => void;
  traceCloseSignal?: number;
  onPublisherSelect?: (selection: {
    unitAddress: string | null;
    endpointId: string;
    topic: string;
  }) => void;
  onSubscriberSelect?: (selection: {
    unitAddress: string | null;
    endpointId: string;
    topic: string;
  }) => void;
  darkMode?: boolean;
};

type PublisherActivityTone = "idle" | "active" | "backpressure";

type SubscriberContributor = {
  id: string;
  endpointId: string;
  displayEndpointId: string;
  topic: string;
  processId: string;
  pid: number;
  host: string;
  messagesWindow: number;
  channelKindLast: string;
  unitAddress: string | null;
};

type PublisherRow = {
  id: string;
  endpointId: string;
  displayEndpointId: string;
  topic: string;
  processId: string;
  pid: number;
  host: string;
  windowSeconds: number;
  publishRateHzWindow: number;
  messagesPublishedWindow: number;
  inflightCurrent: number;
  numBuffers: number | null;
  activityTone: PublisherActivityTone;
  contributors: SubscriberContributor[];
  unitAddress: string | null;
};

type PublisherTraceSample = {
  rowId: string;
  processId: string;
  endpointId: string;
  topic: string;
  timestamp: number;
  metric: string;
  value: number;
  sampleSeq: number | null;
  channelKind: string | null;
};

const TRACE_DEFAULT_WINDOW_SECONDS = 2.0;
const TRACE_WINDOW_MIN_SECONDS = 0.5;
const TRACE_WINDOW_MAX_SECONDS = 30.0;
const TRACE_PUBLISHER_METRICS = new Set(["publish_delta_ns"]);
const TRACE_SUBSCRIBER_METRICS = new Set(["lease_time_ns", "user_span_ns"]);

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatRate(hz: number): string {
  return `${hz.toFixed(1)} Hz`;
}

function formatWindowSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  if (Math.abs(seconds - Math.round(seconds)) < 1e-6) {
    return `${Math.round(seconds)}s`;
  }
  return `${seconds.toFixed(1)}s`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeWindowSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return TRACE_DEFAULT_WINDOW_SECONDS;
  }
  return clamp(value, TRACE_WINDOW_MIN_SECONDS, TRACE_WINDOW_MAX_SECONDS);
}

function defaultTraceWindowSecondsForRate(rateHz: number): number {
  if (!Number.isFinite(rateHz) || rateHz <= 0) {
    return TRACE_DEFAULT_WINDOW_SECONDS;
  }
  const targetSeconds = Math.max(TRACE_DEFAULT_WINDOW_SECONDS, Math.round(10 / rateHz));
  return normalizeWindowSeconds(targetSeconds);
}

function shortEndpointToken(endpointId: string): string {
  const parts = endpointId.split(":");
  const last = parts.length > 0 ? parts[parts.length - 1] : endpointId;
  if (last.length >= 8) {
    return last.slice(0, 8);
  }
  return endpointId.slice(0, 8);
}

function shortTopic(topic: string, max = 48): string {
  if (topic.length <= max) {
    return topic;
  }
  return `${topic.slice(0, max - 1)}…`;
}

function publisherActivityTone(
  messagesPublishedWindow: number,
  inflightCurrent: number,
  numBuffers: number | null
): PublisherActivityTone {
  if (numBuffers !== null && numBuffers > 0 && inflightCurrent / numBuffers > 0.5) {
    return "backpressure";
  }
  if (messagesPublishedWindow > 0) {
    return "active";
  }
  return "idle";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function canonicalizeProfilingTopic(
  topic: string,
  relayEndpointByInternalTopic: Map<string, string>
): string {
  return (
    relayEndpointByInternalTopic.get(topic)
    ?? relayEndpointByInternalTopic.get(streamAddressWithoutEndpoint(topic))
    ?? topic
  );
}

function canonicalizeProfilingEndpointId(
  endpointId: string,
  relayEndpointByInternalTopic: Map<string, string>
): string {
  const { topic, endpointToken } = parseTopicAndEndpoint(endpointId);
  if (topic.length === 0 || endpointToken.length === 0) {
    return endpointId;
  }
  return `${canonicalizeProfilingTopic(topic, relayEndpointByInternalTopic)}:${endpointToken}`;
}

function extractTraceSamples(
  event: ProfilingTraceEnvelope | null,
  relayEndpointByInternalTopic: Map<string, string>
): PublisherTraceSample[] {
  if (!event) {
    return [];
  }
  const out: PublisherTraceSample[] = [];
  for (const [processId, processBatch] of Object.entries(event.data.batches)) {
    if (!isRecord(processBatch)) {
      continue;
    }
    const samples = processBatch.samples;
    if (!Array.isArray(samples)) {
      continue;
    }
    for (const sample of samples) {
      if (!isRecord(sample)) {
        continue;
      }
      const endpointId = sample.endpoint_id;
      const topic = sample.topic;
      const metric = sample.metric;
      const value = sample.value;
      const timestamp = sample.timestamp;
      const sampleSeq = sample.sample_seq;
      if (
        typeof endpointId !== "string"
        || typeof topic !== "string"
        || typeof metric !== "string"
        || typeof value !== "number"
        || !Number.isFinite(value)
      ) {
        continue;
      }
      const canonicalEndpointId = canonicalizeProfilingEndpointId(
        endpointId,
        relayEndpointByInternalTopic
      );
      const canonicalTopic = canonicalizeProfilingTopic(topic, relayEndpointByInternalTopic);
      out.push({
        rowId: `${processId}:${canonicalEndpointId}`,
        processId,
        endpointId: canonicalEndpointId,
        topic: canonicalTopic,
        timestamp:
          typeof timestamp === "number" && Number.isFinite(timestamp)
            ? timestamp
            : event.data.timestamp,
        metric,
        value,
        sampleSeq:
          typeof sampleSeq === "number" && Number.isFinite(sampleSeq)
            ? Math.trunc(sampleSeq)
            : null,
        channelKind:
          typeof sample.channel_kind === "string" ? sample.channel_kind : null,
      });
    }
  }
  return out;
}

function toContributor(
  process: ProcessProfilingSnapshotPayload,
  subscriber: SubscriberProfilingSnapshot,
  endpointOwnerById: Map<string, string>,
  endpointOwnerByTopic: Map<string, string>,
  relayEndpointByInternalTopic: Map<string, string>
): SubscriberContributor {
  const topic = canonicalizeProfilingTopic(
    subscriber.topic,
    relayEndpointByInternalTopic
  );
  return {
    id: `${process.process_id}:${subscriber.endpoint_id}`,
    endpointId: subscriber.endpoint_id,
    displayEndpointId: canonicalizeProfilingEndpointId(
      subscriber.endpoint_id,
      relayEndpointByInternalTopic
    ),
    topic,
    processId: process.process_id,
    pid: process.pid,
    host: process.host,
    messagesWindow: toNumber(subscriber.messages_received_window),
    channelKindLast:
      typeof subscriber.channel_kind_last === "string"
        ? subscriber.channel_kind_last
        : "unknown",
    unitAddress:
      endpointOwnerById.get(subscriber.endpoint_id)
      ?? endpointOwnerByTopic.get(topic)
      ?? null,
  };
}

function topicScopeForPublisher(
  topic: string,
  graphSnapshot: GraphSnapshotPayload | null,
  relayEndpointByInternalTopic: Map<string, string>
): Set<string> {
  const normalizedTopic = canonicalizeProfilingTopic(
    topic,
    relayEndpointByInternalTopic
  );
  const candidateTopics = new Set<string>([normalizedTopic]);
  const rawTopics = new Set<string>([topic, normalizedTopic]);
  for (const rawTopic of rawTopics) {
    const routedTopics = graphSnapshot?.graph[rawTopic];
    if (!Array.isArray(routedTopics)) {
      continue;
    }
    for (const routedTopic of routedTopics) {
      if (typeof routedTopic === "string") {
        candidateTopics.add(
          canonicalizeProfilingTopic(routedTopic, relayEndpointByInternalTopic)
        );
      }
    }
  }
  return candidateTopics;
}

function sampleTopicMatchesScope(sampleTopic: string, topicScope: Set<string>): boolean {
  if (topicScope.has(sampleTopic)) {
    return true;
  }
  for (const candidateTopic of topicScope) {
    if (sampleTopic.startsWith(`${candidateTopic}:`)) {
      return true;
    }
  }
  return false;
}

function contributorListForPublisher(
  topic: string,
  subscribers: SubscriberContributor[],
  graphSnapshot: GraphSnapshotPayload | null,
  relayEndpointByInternalTopic: Map<string, string>
): SubscriberContributor[] {
  const candidateTopics = topicScopeForPublisher(
    topic,
    graphSnapshot,
    relayEndpointByInternalTopic
  );

  return subscribers
    .filter((subscriber) => candidateTopics.has(subscriber.topic))
    .sort((a, b) => {
      const byTopic = a.topic.localeCompare(b.topic);
      if (byTopic !== 0) {
        return byTopic;
      }
      const byProcess = a.processId.localeCompare(b.processId);
      if (byProcess !== 0) {
        return byProcess;
      }
      return a.endpointId.localeCompare(b.endpointId);
    });
}

function toPublisherRow(
  process: ProcessProfilingSnapshotPayload,
  publisher: PublisherProfilingSnapshot,
  allSubscribers: SubscriberContributor[],
  graphSnapshot: GraphSnapshotPayload | null,
  endpointOwnerById: Map<string, string>,
  endpointOwnerByTopic: Map<string, string>,
  relayEndpointByInternalTopic: Map<string, string>
): PublisherRow {
  const rowId = `${process.process_id}:${publisher.endpoint_id}`;
  const rawNumBuffers = publisher["num_buffers"];
  const numBuffers =
    typeof rawNumBuffers === "number" && Number.isFinite(rawNumBuffers)
      ? Math.max(0, Math.trunc(rawNumBuffers))
      : null;
  const topic = canonicalizeProfilingTopic(
    publisher.topic,
    relayEndpointByInternalTopic
  );
  return {
    id: rowId,
    endpointId: publisher.endpoint_id,
    displayEndpointId: canonicalizeProfilingEndpointId(
      publisher.endpoint_id,
      relayEndpointByInternalTopic
    ),
    topic,
    processId: process.process_id,
    pid: process.pid,
    host: process.host,
    windowSeconds: toNumber(process.window_seconds),
    publishRateHzWindow: toNumber(publisher.publish_rate_hz_window),
    messagesPublishedWindow: toNumber(publisher.messages_published_window),
    inflightCurrent: toNumber(publisher.inflight_messages_current),
    numBuffers,
    activityTone: publisherActivityTone(
      toNumber(publisher.messages_published_window),
      toNumber(publisher.inflight_messages_current),
      numBuffers
    ),
    contributors: contributorListForPublisher(
      topic,
      allSubscribers,
      graphSnapshot,
      relayEndpointByInternalTopic
    ),
    unitAddress:
      endpointOwnerById.get(publisher.endpoint_id)
      ?? endpointOwnerByTopic.get(topic)
      ?? null,
  };
}

export function ProfilingPanel({
  graphSnapshot,
  profilingSnapshot,
  latestTraceEvent,
  setProfilingTraceControl,
  focusPublisherEndpointId = null,
  focusPublisherTopic = null,
  focusSubscriberEndpointId = null,
  focusUnitAddress = null,
  focusActionId = 0,
  showSettingsChannels = false,
  hideFilters = false,
  defaultTraceMetrics = ["publish_delta_ns", "lease_time_ns", "user_span_ns"],
  traceDockHost = null,
  onTraceDockStateChange,
  traceCloseSignal = 0,
  onPublisherSelect,
  onSubscriberSelect,
  darkMode = false,
}: ProfilingPanelProps) {
  const [searchText, setSearchText] = useState("");
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [activeTraceRowIds, setActiveTraceRowIds] = useState<string[]>([]);
  const [traceSamplesByRowId, setTraceSamplesByRowId] = useState<
    Record<string, PublisherTraceSample[]>
  >({});
  const [traceControlPending, setTraceControlPending] = useState<
    Record<string, boolean>
  >({});
  const [traceControlError, setTraceControlError] = useState<
    Record<string, string | null>
  >({});
  const [traceWindowSecondsByRowId, setTraceWindowSecondsByRowId] = useState<
    Record<string, number>
  >({});
  const [expandedContributorEndpointByRowId, setExpandedContributorEndpointByRowId] =
    useState<Record<string, string | null>>({});
  const lastTraceCloseSignalRef = useRef(traceCloseSignal);
  const lastHandledFocusActionIdRef = useRef<number>(-1);
  const rowRefs = useRef<Record<string, HTMLElement | null>>({});

  const processRows = useMemo(
    () => (profilingSnapshot ? Object.values(profilingSnapshot) : []),
    [profilingSnapshot]
  );
  const topologyComponents = useMemo(
    () => (graphSnapshot ? classifyComponents(graphSnapshot) : null),
    [graphSnapshot]
  );
  const relayEndpointByInternalTopic = useMemo(() => {
    if (!topologyComponents) {
      return new Map<string, string>();
    }
    return buildRelayAliasIndex(topologyComponents.collections).endpointByInternalTopic;
  }, [topologyComponents]);
  const endpointOwnerById = useMemo(() => {
    const index = new Map<string, string>();
    if (!topologyComponents) {
      return index;
    }
    const registerOwner = (componentAddress: string, streamAddress: string) => {
      const endpointId = endpointIdFromStreamAddress(streamAddress);
      if (endpointId && !index.has(endpointId)) {
        index.set(endpointId, componentAddress);
      }
    };
    for (const unit of topologyComponents.units.values()) {
      for (const stream of unit.streams) {
        registerOwner(unit.address, stream.address);
      }
    }
    for (const collection of topologyComponents.collections.values()) {
      for (const stream of collection.streams) {
        registerOwner(collection.address, stream.address);
      }
    }
    return index;
  }, [topologyComponents]);
  const endpointOwnerByTopic = useMemo(() => {
    const index = new Map<string, string>();
    if (!topologyComponents) {
      return index;
    }
    const registerOwner = (componentAddress: string, streamAddress: string) => {
      index.set(streamAddress, componentAddress);
      index.set(streamAddressWithoutEndpoint(streamAddress), componentAddress);
    };
    for (const unit of topologyComponents.units.values()) {
      for (const stream of unit.streams) {
        registerOwner(unit.address, stream.address);
      }
    }
    for (const collection of topologyComponents.collections.values()) {
      for (const stream of collection.streams) {
        registerOwner(collection.address, stream.address);
      }
    }
    return index;
  }, [topologyComponents]);

  const publisherRows = useMemo(() => {
    const allSubscribers: SubscriberContributor[] = [];
    for (const process of processRows) {
      for (const subscriber of Object.values(process.subscribers)) {
        allSubscribers.push(
          toContributor(
            process,
            subscriber,
            endpointOwnerById,
            endpointOwnerByTopic,
            relayEndpointByInternalTopic
          )
        );
      }
    }

    const rows: PublisherRow[] = [];
    for (const process of processRows) {
      for (const publisher of Object.values(process.publishers)) {
        rows.push(
          toPublisherRow(
            process,
            publisher,
            allSubscribers,
            graphSnapshot,
            endpointOwnerById,
            endpointOwnerByTopic,
            relayEndpointByInternalTopic
          )
        );
      }
    }

    const visibleRows = showSettingsChannels
      ? rows
      : rows.filter((row) => !isSettingsChannelTopic(row.topic));

    return visibleRows.sort((a, b) => {
      const byTopic = a.topic.localeCompare(b.topic);
      if (byTopic !== 0) {
        return byTopic;
      }
      const byProcess = a.processId.localeCompare(b.processId);
      if (byProcess !== 0) {
        return byProcess;
      }
      return a.endpointId.localeCompare(b.endpointId);
    });
  }, [
    endpointOwnerById,
    endpointOwnerByTopic,
    graphSnapshot,
    processRows,
    relayEndpointByInternalTopic,
    showSettingsChannels,
  ]);

  const filteredRows = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return publisherRows.filter((row) => {
      if (query.length === 0) {
        return true;
      }
      return (
        row.topic.toLowerCase().includes(query)
        || row.endpointId.toLowerCase().includes(query)
        || row.processId.toLowerCase().includes(query)
      );
    });
  }, [publisherRows, searchText]);

  const rowById = useMemo(
    () => new Map(publisherRows.map((row) => [row.id, row])),
    [publisherRows]
  );

  useEffect(() => {
    if (focusActionId === lastHandledFocusActionIdRef.current) {
      return;
    }
    // Expand the matched rows and scroll the first one into view. Returns
    // without marking the request handled when nothing matched, so a focus
    // request can still land once the rows arrive in a later snapshot.
    const revealRows = (
      matchedIds: string[],
      contributorEndpointId: string | null
    ): void => {
      if (matchedIds.length === 0) {
        return;
      }
      lastHandledFocusActionIdRef.current = focusActionId;
      setSearchText("");
      setExpandedIds(matchedIds);
      setExpandedContributorEndpointByRowId((previous) => {
        if (contributorEndpointId === null) {
          return {};
        }
        const next: Record<string, string | null> = { ...previous };
        for (const rowId of matchedIds) {
          next[rowId] = contributorEndpointId;
        }
        return next;
      });
      window.requestAnimationFrame(() => {
        rowRefs.current[matchedIds[0]]?.scrollIntoView({
          block: "nearest",
          behavior: "smooth",
        });
      });
    };

    if (focusPublisherEndpointId) {
      revealRows(
        publisherRows
          .filter((row) => {
            if (row.endpointId === focusPublisherEndpointId) {
              return true;
            }
            if (!focusPublisherTopic) {
              return false;
            }
            return row.topic === focusPublisherTopic;
          })
          .map((row) => row.id),
        null
      );
      return;
    }
    if (focusSubscriberEndpointId) {
      revealRows(
        publisherRows
          .filter((row) =>
            row.contributors.some(
              (contributor) =>
                contributor.endpointId === focusSubscriberEndpointId
            )
          )
          .map((row) => row.id),
        focusSubscriberEndpointId
      );
      return;
    }
    if (focusUnitAddress) {
      // A whole component is selected, so reveal every topic it publishes.
      revealRows(
        publisherRows
          .filter((row) => row.unitAddress === focusUnitAddress)
          .map((row) => row.id),
        null
      );
    }
  }, [
    focusPublisherEndpointId,
    focusPublisherTopic,
    focusSubscriberEndpointId,
    focusUnitAddress,
    focusActionId,
    publisherRows,
  ]);

  useEffect(() => {
    if (!latestTraceEvent || activeTraceRowIds.length === 0) {
      return;
    }
    const extracted = extractTraceSamples(
      latestTraceEvent,
      relayEndpointByInternalTopic
    );
    if (extracted.length === 0) {
      return;
    }
    const activeIds = new Set(activeTraceRowIds);
    const activeRowsWithTopicScope = activeTraceRowIds
      .map((rowId) => rowById.get(rowId))
      .filter((row): row is PublisherRow => row !== undefined)
      .map((row) => ({
        row,
        topicScope: topicScopeForPublisher(
          row.topic,
          graphSnapshot,
          relayEndpointByInternalTopic
        ),
      }));
    const topicScopeByRowId = new Map(
      activeRowsWithTopicScope.map((entry) => [entry.row.id, entry.topicScope])
    );
    setTraceSamplesByRowId((previous) => {
      let changed = false;
      const next: Record<string, PublisherTraceSample[]> = { ...previous };
      const pendingByRowId: Record<string, PublisherTraceSample[]> = {};
      for (const sample of extracted) {
        const matchedRowIds = new Set<string>();
        const publisherRow = rowById.get(sample.rowId);
        const publisherTopicScope = topicScopeByRowId.get(sample.rowId);
        if (
          publisherRow
          && activeIds.has(sample.rowId)
          && publisherTopicScope
          && sampleTopicMatchesScope(sample.topic, publisherTopicScope)
          && TRACE_PUBLISHER_METRICS.has(sample.metric)
        ) {
          matchedRowIds.add(sample.rowId);
        }
        if (TRACE_SUBSCRIBER_METRICS.has(sample.metric)) {
          for (const activeRow of activeRowsWithTopicScope) {
            if (sampleTopicMatchesScope(sample.topic, activeRow.topicScope)) {
              matchedRowIds.add(activeRow.row.id);
            }
          }
        }
        for (const rowId of matchedRowIds) {
          const pending = pendingByRowId[rowId];
          if (pending) {
            pending.push(sample);
          } else {
            pendingByRowId[rowId] = [sample];
          }
        }
      }
      for (const [rowId, pending] of Object.entries(pendingByRowId)) {
        if (pending.length === 0) {
          continue;
        }
        next[rowId] = pending;
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [
    activeTraceRowIds,
    graphSnapshot,
    latestTraceEvent,
    relayEndpointByInternalTopic,
    rowById,
  ]);

  const applyTraceControl = async (
    row: PublisherRow,
    nextOpen: boolean
  ): Promise<void> => {
    if (traceControlPending[row.id]) {
      return;
    }
    setTraceControlPending((previous) => ({ ...previous, [row.id]: true }));
    setTraceControlError((previous) => ({ ...previous, [row.id]: null }));
    if (nextOpen) {
      setTraceSamplesByRowId((previous) => ({ ...previous, [row.id]: [] }));
      setTraceWindowSecondsByRowId((previous) =>
        previous[row.id] !== undefined
          ? previous
          : {
              ...previous,
              [row.id]: defaultTraceWindowSecondsForRate(row.publishRateHzWindow),
            }
      );
      setActiveTraceRowIds([row.id]);
    } else {
      setActiveTraceRowIds((previous) =>
        previous.includes(row.id)
          ? previous.filter((existingId) => existingId !== row.id)
          : previous
      );
    }
    try {
      if (nextOpen) {
        const previousActiveId = activeTraceRowIds.find(
          (activeId) => activeId !== row.id
        );
        if (previousActiveId) {
          const previousRow = rowById.get(previousActiveId);
          if (previousRow) {
            await setProfilingTraceControl({
              process_id: previousRow.processId,
              enabled: false,
              publisher_endpoint_id: null,
              publisher_topic: null,
              subscriber_topic: null,
              metrics: null,
              sample_mod: 1,
              ttl_seconds: null,
              timeout: 2.0,
            });
          }
        }
      }
      await setProfilingTraceControl({
        process_id: row.processId,
        enabled: nextOpen,
        publisher_endpoint_id: nextOpen ? row.endpointId : null,
        publisher_topic: null,
        subscriber_topic: nextOpen ? row.topic : null,
        metrics: nextOpen ? defaultTraceMetrics : null,
        sample_mod: 1,
        ttl_seconds: null,
        timeout: 2.0,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Trace control request failed.";
      setTraceControlError((previous) => ({ ...previous, [row.id]: message }));
      setActiveTraceRowIds((previous) =>
        nextOpen
          ? previous.filter((existingId) => existingId !== row.id)
          : previous.includes(row.id)
            ? previous
            : [...previous, row.id]
      );
    } finally {
      setTraceControlPending((previous) => ({ ...previous, [row.id]: false }));
    }
  };

  const toggleExpanded = (row: PublisherRow) => {
    const nextExpanded = !expandedIds.includes(row.id);
    if (nextExpanded) {
      onPublisherSelect?.({
        unitAddress: row.unitAddress,
        endpointId: row.endpointId,
        topic: row.topic,
      });
    }
    setExpandedIds((previous) =>
      previous.includes(row.id)
        ? previous.filter((existingId) => existingId !== row.id)
        : [...previous, row.id]
    );
    if (!nextExpanded) {
      setExpandedContributorEndpointByRowId((previous) => ({
        ...previous,
        [row.id]: null,
      }));
    }
    if (!nextExpanded && activeTraceRowIds.includes(row.id)) {
      void applyTraceControl(row, false);
    }
  };

  const toggleTraceCapture = (row: PublisherRow, nextOpen: boolean) => {
    void applyTraceControl(row, nextOpen);
  };
  const controlsHidden = hideFilters;
  const activeTraceRowId = activeTraceRowIds[0] ?? null;
  const activeTraceRow = activeTraceRowId ? rowById.get(activeTraceRowId) ?? null : null;
  const activeTraceSamples =
    activeTraceRowId ? (traceSamplesByRowId[activeTraceRowId] ?? []) : [];
  const activeTraceBusy = activeTraceRowId
    ? Boolean(traceControlPending[activeTraceRowId])
    : false;
  const activeTraceErrorMessage = activeTraceRowId
    ? (traceControlError[activeTraceRowId] ?? null)
    : null;
  const activeTraceWindowSeconds = normalizeWindowSeconds(
    activeTraceRowId
      ? (traceWindowSecondsByRowId[activeTraceRowId] ?? TRACE_DEFAULT_WINDOW_SECONDS)
      : TRACE_DEFAULT_WINDOW_SECONDS
  );
  const activeTraceTopicScope = activeTraceRow
    ? Array.from(
      topicScopeForPublisher(
        activeTraceRow.topic,
        graphSnapshot,
        relayEndpointByInternalTopic
      )
    )
    : [];
  const activeTraceSubscriberEndpointIds = activeTraceSamples
    .filter(
      (sample) => sample.metric === "lease_time_ns" || sample.metric === "user_span_ns"
    )
    .map((sample) => sample.endpointId);
  const activeTraceLeaseColorMap = buildLeaseColorMap([
    ...(activeTraceRow?.contributors.map((contributor) => contributor.endpointId) ?? []),
    ...activeTraceSubscriberEndpointIds,
  ]);
  const activeSelectedContributorEndpointId =
    activeTraceRowId
      ? (expandedContributorEndpointByRowId[activeTraceRowId] ?? null)
      : null;

  useEffect(() => {
    if (traceCloseSignal === lastTraceCloseSignalRef.current) {
      return;
    }
    lastTraceCloseSignalRef.current = traceCloseSignal;
    const activeTraceRowId = activeTraceRowIds[0];
    if (!activeTraceRowId) {
      return;
    }
    const activeRow = rowById.get(activeTraceRowId);
    if (!activeRow) {
      setActiveTraceRowIds([]);
      return;
    }
    setActiveTraceRowIds([]);
    void setProfilingTraceControl({
      process_id: activeRow.processId,
      enabled: false,
      publisher_endpoint_id: null,
      publisher_topic: null,
      subscriber_topic: null,
      metrics: null,
      sample_mod: 1,
      ttl_seconds: null,
      timeout: 2.0,
    });
  }, [activeTraceRowIds, rowById, setProfilingTraceControl, traceCloseSignal]);


  useEffect(() => {
    if (!onTraceDockStateChange) {
      return;
    }
    if (!activeTraceRow) {
      onTraceDockStateChange(null);
      return;
    }
    onTraceDockStateChange({
      active: true,
      topic: activeTraceRow.topic,
      endpointId: activeTraceRow.endpointId,
      status: activeTraceBusy ? "applying" : "capturing",
    });
  }, [activeTraceBusy, activeTraceRow, onTraceDockStateChange]);

  const traceDockContent =
    traceDockHost && activeTraceRow
      ? createPortal(
          <div className="trace-dock-trace">
            {activeTraceSamples.length === 0 ? (
              <p className="muted">
                Waiting for trace samples on this publisher endpoint.
              </p>
            ) : (
              <TraceTimingPanel
                samples={activeTraceSamples as TimingTraceSample[]}
                publisherProcessId={activeTraceRow.processId}
                publisherEndpointId={activeTraceRow.endpointId}
                nominalPublishRateHz={activeTraceRow.publishRateHzWindow}
                topic={activeTraceRow.topic}
                topicScope={activeTraceTopicScope}
                leaseColorMap={activeTraceLeaseColorMap}
                selectedSubscriberEndpointId={activeSelectedContributorEndpointId}
                windowSeconds={activeTraceWindowSeconds}
                darkMode={darkMode}
                onWindowSecondsChange={(nextSeconds) =>
                  setTraceWindowSecondsByRowId((previous) => ({
                    ...previous,
                    [activeTraceRow.id]: normalizeWindowSeconds(nextSeconds),
                  }))
                }
              />
            )}
            {activeTraceErrorMessage ? (
              <p className="patch-status err">{activeTraceErrorMessage}</p>
            ) : null}
          </div>,
          traceDockHost
        )
      : null;

  return (
    <Panel>
      {publisherRows.length === 0 ? (
        <div className="panel-section">
          <p className="muted">No publishers snapshot entries available.</p>
        </div>
      ) : (
        <>
          {controlsHidden ? null : (
            <div className="settings-search">
              <input
                type="search"
                placeholder="Search topic, endpoint, or process"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
              />
            </div>
          )}

          {filteredRows.length === 0 ? (
            <div className="panel-section">
              <p className="muted">No publishers match the current filter.</p>
            </div>
          ) : (
            <div className="publisher-list">
              {filteredRows.map((row) => {
            const expanded = expandedIds.includes(row.id);
            const traceOpen = activeTraceRowIds.includes(row.id);
            const traceBusy = Boolean(traceControlPending[row.id]);
            const windowLabel = formatWindowSeconds(row.windowSeconds);
            const leaseColorMap = buildLeaseColorMap(
              row.contributors.map((contributor) => contributor.endpointId)
            );
            const expandedContributorEndpointId =
              expandedContributorEndpointByRowId[row.id] ?? null;
            const selectedContributorEndpointId = row.contributors.some(
              (contributor) => contributor.endpointId === expandedContributorEndpointId
            )
              ? expandedContributorEndpointId
              : null;
            return (
              <article
                key={row.id}
                ref={(element) => {
                  rowRefs.current[row.id] = element;
                }}
                className={`publisher-row activity-${row.activityTone}`}
              >
                <button
                  type="button"
                  className="publisher-row__toggle"
                  onClick={() => toggleExpanded(row)}
                  aria-expanded={expanded}
                >
                  <div className="publisher-row__top">
                    <div className="publisher-row__identity">
                      <div className="publisher-row__identity-text">
                        <p className="mono publisher-topic" title={row.topic}>
                          {row.topic}
                        </p>
                      </div>
                    </div>
                    <span className="publisher-caret">{expanded ? "▾" : "▸"}</span>
                  </div>

                  <div className="publisher-row__metrics">
                    <div>
                      <span>Rate</span>
                      <strong>{formatRate(row.publishRateHzWindow)}</strong>
                    </div>
                    <div>
                      <span>{windowLabel ? `Msgs (${windowLabel})` : "Msgs"}</span>
                      <strong>{row.messagesPublishedWindow}</strong>
                    </div>
                    <div>
                      <span>Inflight</span>
                      <strong>
                        {row.numBuffers === null
                          ? `${row.inflightCurrent}`
                          : `${row.inflightCurrent} / ${row.numBuffers}`}
                      </strong>
                    </div>
                    <div>
                      <span>Subscribers</span>
                      <strong>{row.contributors.length}</strong>
                    </div>
                  </div>
                </button>

                {expanded ? (
                  <div className="publisher-row__details">
                    <div className="publisher-kpis">
                      <article className="mini-kpi">
                        <span>Host</span>
                        <strong>{row.host}</strong>
                      </article>
                      <article className="mini-kpi">
                        <span>PID</span>
                        <strong>{row.pid}</strong>
                      </article>
                      <article className="mini-kpi">
                        <span>Process</span>
                        <strong className="mono" title={row.processId}>
                          {row.processId.slice(0, 8)}
                        </strong>
                      </article>
                    </div>
                    <div className="publisher-detail-line">
                      <div className="publisher-endpoint">
                        <span>Endpoint</span>
                        <code className="mono" title={row.displayEndpointId}>
                          {row.displayEndpointId}
                        </code>
                      </div>
                    </div>

                    <div className="panel-section">
                      <button
                        type="button"
                        className={`publisher-trace-button ${
                          traceOpen ? "is-stop" : "is-start"
                        }`}
                        onClick={() => toggleTraceCapture(row, !traceOpen)}
                        disabled={traceBusy}
                        aria-pressed={traceOpen}
                      >
                        <span aria-hidden="true" className="publisher-trace-button__icon">
                          {traceOpen ? "■" : "▶"}
                        </span>
                        <span>
                          {traceBusy ? "Applying..." : traceOpen ? "Stop Profiling Trace" : "Start Profiling Trace"}
                        </span>
                      </button>
                      <div className="subscriber-section-header">
                        <h3>Subscribers</h3>
                      </div>
                      {row.contributors.length === 0 ? (
                        <p className="muted">
                          No subscriber profiling data is available for this topic.
                        </p>
                      ) : (
                        <div className="subscriber-list">
                          {row.contributors.map((contributor) => {
                            const contributorExpanded =
                              selectedContributorEndpointId === contributor.endpointId;
                            return (
                              <article
                                className={`subscriber-item ${
                                  contributorExpanded ? "is-expanded" : ""
                                }`}
                                key={contributor.id}
                              >
                                <button
                                  type="button"
                                  className="subscriber-item__summary"
                                  onClick={() => {
                                    const nextEndpointId = contributorExpanded
                                      ? null
                                      : contributor.endpointId;
                                    if (nextEndpointId) {
                                      onSubscriberSelect?.({
                                        unitAddress: contributor.unitAddress,
                                        endpointId: contributor.endpointId,
                                        topic: contributor.topic,
                                      });
                                    }
                                    setExpandedContributorEndpointByRowId(
                                      (previous) => ({
                                        ...previous,
                                        [row.id]: nextEndpointId,
                                      })
                                    );
                                  }}
                                >
                                  <div className="subscriber-item__identity">
                                    <p
                                      className="mono subscriber-topic-short"
                                      title={contributor.topic}
                                    >
                                      <span className="subscriber-topic-with-color">
                                        <i
                                          className="subscriber-trace-dot"
                                          style={{
                                            background: leaseColorForEndpoint(
                                              contributor.endpointId,
                                              leaseColorMap
                                            ),
                                          }}
                                        />
                                        <span className="subscriber-topic-label">
                                          {shortTopic(contributor.topic, 72)}
                                        </span>
                                      </span>
                                    </p>
                                  </div>
                                  <div className="subscriber-item__metrics">
                                    <span>
                                      <em>{windowLabel ? `Msgs (${windowLabel})` : "Msgs"}</em>
                                      <strong>{contributor.messagesWindow}</strong>
                                    </span>
                                    <span>
                                      <em>Channel</em>
                                      <strong>{contributor.channelKindLast}</strong>
                                    </span>
                                  </div>
                                </button>
                                {contributorExpanded ? (
                                  <div className="subscriber-item__detail">
                                    <>
                                      <div className="publisher-kpis">
                                        <article className="mini-kpi">
                                          <span>Host</span>
                                          <strong>{contributor.host}</strong>
                                        </article>
                                        <article className="mini-kpi">
                                          <span>PID</span>
                                          <strong>{contributor.pid}</strong>
                                        </article>
                                        <article className="mini-kpi">
                                          <span>Process</span>
                                          <strong
                                            className="mono"
                                            title={contributor.processId}
                                          >
                                            {contributor.processId.slice(0, 8)}
                                          </strong>
                                        </article>
                                      </div>
                                      <div className="publisher-detail-line">
                                        <div className="publisher-endpoint">
                                          <span>Endpoint</span>
                                          <code
                                            className="mono"
                                            title={contributor.displayEndpointId}
                                          >
                                            {contributor.displayEndpointId}
                                          </code>
                                        </div>
                                      </div>
                                    </>
                                  </div>
                                ) : null}
                              </article>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
              </article>
            );
              })}
            </div>
          )}
        </>
      )}
      {traceDockContent}
    </Panel>
  );
}
