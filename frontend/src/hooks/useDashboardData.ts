import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  DashboardSnapshotResponse,
  HealthResponse,
  ProfilingTraceControlRequest,
  ProfilingTraceControlResponse,
  SettingsFieldPatchResponse,
  SettingsValuePayload,
} from "../types/api";
import type {
  DashboardEventEnvelope,
  ProfilingTraceEnvelope,
  SettingsChangedEnvelope,
  TopologyChangedEnvelope,
} from "../types/events";

type ConnectionState = "connecting" | "open" | "closed";

const MAX_EVENTS = 120;
const SNAPSHOT_REFRESH_DEBOUNCE_MS = 250;
const RECONNECT_DELAY_MS = 1000;
const WS_DEFAULT_PROFILING_INTERVAL = 0.05;
const WS_DEFAULT_PROFILING_MAX_SAMPLES = 5000;

function readPositiveNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function withWsTraceQuery(baseUrl: string): string {
  const interval = readPositiveNumber(
    import.meta.env.VITE_WS_PROFILING_INTERVAL,
    WS_DEFAULT_PROFILING_INTERVAL
  );
  const maxSamples = Math.max(
    1,
    Math.trunc(
      readPositiveNumber(
        import.meta.env.VITE_WS_PROFILING_MAX_SAMPLES,
        WS_DEFAULT_PROFILING_MAX_SAMPLES
      )
    )
  );
  const query = new URLSearchParams({
    profiling_interval: interval.toString(),
    profiling_max_samples: maxSamples.toString(),
  }).toString();
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}${query}`;
}

function wsUrl(): string {
  const configuredBaseUrl = import.meta.env.VITE_WS_BASE_URL as
    | string
    | undefined;
  if (configuredBaseUrl && configuredBaseUrl.length > 0) {
    return withWsTraceQuery(`${configuredBaseUrl.replace(/\/$/, "")}/ws/events`);
  }

  if (import.meta.env.DEV) {
    return withWsTraceQuery("ws://127.0.0.1:8000/ws/events");
  }

  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return withWsTraceQuery(`${scheme}://${window.location.host}/ws/events`);
}

async function fetchJsonNoStore<T>(path: string): Promise<T> {
  const separator = path.includes("?") ? "&" : "?";
  const url = `${path}${separator}_ts=${Date.now()}`;
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status})`);
  }
  return (await response.json()) as T;
}

async function postJsonNoStore<T>(path: string, body: unknown): Promise<T> {
  const separator = path.includes("?") ? "&" : "?";
  const url = `${path}${separator}_ts=${Date.now()}`;
  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = `${path} failed (${response.status})`;
    try {
      const payload = (await response.json()) as { detail?: string };
      if (typeof payload.detail === "string" && payload.detail.length > 0) {
        detail = payload.detail;
      }
    } catch {
      // keep the default message
    }
    throw new Error(detail);
  }
  return (await response.json()) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDashboardEventEnvelope(value: unknown): value is DashboardEventEnvelope {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.kind === "string" && isRecord(value.data);
}

export function useDashboardData() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [snapshot, setSnapshot] = useState<DashboardSnapshotResponse | null>(null);
  const [latestTraceEvent, setLatestTraceEvent] =
    useState<ProfilingTraceEnvelope | null>(null);
  const [events, setEvents] = useState<DashboardEventEnvelope[]>([]);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [lastSnapshotUpdateMs, setLastSnapshotUpdateMs] = useState<number | null>(
    null
  );

  const refreshTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  const refreshSnapshot = useCallback(async () => {
    const payload = await fetchJsonNoStore<DashboardSnapshotResponse>(
      "/api/snapshot"
    );
    setSnapshot(payload);
    setLastSnapshotUpdateMs(Date.now());
  }, []);

  const refreshHealth = useCallback(async () => {
    const payload = await fetchJsonNoStore<HealthResponse>("/api/health");
    setHealth(payload);
  }, []);

  const scheduleSnapshotRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => {
      refreshSnapshot().catch((refreshError: unknown) => {
        const message =
          refreshError instanceof Error
            ? refreshError.message
            : "Snapshot refresh failed.";
        setError(message);
      });
      refreshTimerRef.current = null;
    }, SNAPSHOT_REFRESH_DEBOUNCE_MS);
  }, [refreshSnapshot]);

  useEffect(() => {
    refreshHealth().catch((healthError: unknown) => {
      const message =
        healthError instanceof Error ? healthError.message : "Health check failed.";
      setError(message);
    });

    refreshSnapshot().catch((snapshotError: unknown) => {
      const message =
        snapshotError instanceof Error
          ? snapshotError.message
          : "Initial snapshot failed.";
      setError(message);
    });
  }, [refreshHealth, refreshSnapshot]);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;

    const connect = () => {
      if (cancelled) {
        return;
      }
      setConnectionState("connecting");
      socket = new WebSocket(wsUrl());

      socket.onopen = () => {
        if (!cancelled) {
          setConnectionState("open");
          setError(null);
        }
      };

      socket.onmessage = (event) => {
        let payload: unknown = null;
        try {
          payload = JSON.parse(event.data) as unknown;
        } catch {
          return;
        }
        if (!isDashboardEventEnvelope(payload)) {
          return;
        }

        const envelope = payload;
        setEvents((previous) => [envelope, ...previous].slice(0, MAX_EVENTS));

        if (envelope.kind === "topology.changed") {
          scheduleSnapshotRefresh();
        }
        if (envelope.kind === "settings.changed") {
          setSnapshot((previous) => {
            if (!previous) {
              return previous;
            }
            const typed = envelope as SettingsChangedEnvelope;
            const existingValue =
              previous.settings[typed.data.component_address] ?? null;
            const nextSettings: Record<string, SettingsValuePayload> = {
              ...previous.settings,
              [typed.data.component_address]: {
                ...typed.data.value,
                patchable: existingValue?.patchable ?? false,
                patch_error: existingValue?.patch_error ?? null,
                component_type: existingValue?.component_type ?? null,
                component_name: existingValue?.component_name ?? null,
              },
            };
            return { ...previous, settings: nextSettings };
          });
        }
        if (envelope.kind === "profiling.trace") {
          setLatestTraceEvent(envelope as ProfilingTraceEnvelope);
        }
        if (envelope.kind === "system.error") {
          setError(envelope.data.message);
        }
      };

      socket.onerror = () => {
        if (!cancelled) {
          setConnectionState("closed");
        }
      };

      socket.onclose = () => {
        if (cancelled) {
          return;
        }
        setConnectionState("closed");
        reconnectTimerRef.current = window.setTimeout(() => {
          connect();
        }, RECONNECT_DELAY_MS);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (socket !== null) {
        socket.close();
      }
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, [scheduleSnapshotRefresh]);

  const topologyEvents = useMemo(
    () =>
      events.filter(
        (event): event is TopologyChangedEnvelope =>
          event.kind === "topology.changed"
      ),
    [events]
  );

  const reloadSnapshot = useCallback(async () => {
    try {
      await refreshSnapshot();
    } catch (snapshotError: unknown) {
      const message =
        snapshotError instanceof Error
          ? snapshotError.message
          : "Snapshot refresh failed.";
      setError(message);
    }
  }, [refreshSnapshot]);

  const patchSettingField = useCallback(
    async (
      componentAddress: string,
      fieldPath: string,
      value: unknown,
      timeout = 2.0
    ) => {
      const encodedAddress = encodeURIComponent(componentAddress);
      const payload = await postJsonNoStore<SettingsFieldPatchResponse>(
        `/api/settings/${encodedAddress}/field`,
        {
          field_path: fieldPath,
          value,
          timeout,
        }
      );
      setSnapshot((previous) => {
        if (!previous) {
          return previous;
        }
        const existingValue = previous.settings[payload.component_address] ?? null;
        return {
          ...previous,
          settings: {
            ...previous.settings,
            [payload.component_address]: {
              ...payload.updated_value,
              patchable: existingValue?.patchable ?? true,
              patch_error: existingValue?.patch_error ?? null,
              component_type: existingValue?.component_type ?? null,
              component_name: existingValue?.component_name ?? null,
            },
          },
        };
      });
      setLastSnapshotUpdateMs(Date.now());
      return payload;
    },
    []
  );

  const setProfilingTraceControl = useCallback(
    async (request: ProfilingTraceControlRequest) => {
      return await postJsonNoStore<ProfilingTraceControlResponse>(
        "/api/profiling/trace-control",
        request
      );
    },
    []
  );

  return {
    health,
    snapshot,
    latestTraceEvent,
    events,
    topologyEvents,
    connectionState,
    error,
    lastSnapshotUpdateMs,
    refreshSnapshot: reloadSnapshot,
    patchSettingField,
    setProfilingTraceControl,
  };
}
