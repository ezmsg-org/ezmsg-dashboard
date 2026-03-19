export type TopologyChangedEnvelope = {
  kind: "topology.changed";
  data: {
    seq: number;
    event_type: string;
    timestamp: number;
    changed_topics: string[];
    source_session_id: string | null;
    source_process_id: string | null;
  };
};

export type SettingsValuePayload = {
  repr_value: Record<string, unknown> | string;
  structured_value: Record<string, unknown> | null;
  settings_schema: Record<string, unknown> | null;
  serialized_present: boolean;
};

export type SettingsChangedEnvelope = {
  kind: "settings.changed";
  data: {
    seq: number;
    event_type: string;
    component_address: string;
    timestamp: number;
    source_session_id: string | null;
    source_process_id: string | null;
    value: SettingsValuePayload;
  };
};

export type ProfilingTraceEnvelope = {
  kind: "profiling.trace";
  data: {
    timestamp: number;
    batches: Record<string, Record<string, unknown>>;
  };
};

export type SystemReadyEnvelope = {
  kind: "system.ready";
  data: {
    timestamp: number;
    message: string;
  };
};

export type SystemHeartbeatEnvelope = {
  kind: "system.heartbeat";
  data: {
    timestamp: number;
  };
};

export type SystemErrorEnvelope = {
  kind: "system.error";
  data: {
    timestamp: number;
    message: string;
  };
};

export type DashboardEventEnvelope =
  | TopologyChangedEnvelope
  | SettingsChangedEnvelope
  | ProfilingTraceEnvelope
  | SystemReadyEnvelope
  | SystemHeartbeatEnvelope
  | SystemErrorEnvelope;
