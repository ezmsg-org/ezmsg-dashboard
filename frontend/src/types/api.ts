export type SettingsValuePayload = {
  repr_value: Record<string, unknown> | string;
  structured_value: Record<string, unknown> | null;
  settings_schema: Record<string, unknown> | null;
  serialized_present: boolean;
};

export type SettingsSnapshotPayload = Record<string, SettingsValuePayload>;

export type SnapshotProcess = {
  process_id: string;
  pid: number | null;
  host: string | null;
  units: string[];
};

export type GraphSnapshotPayload = {
  graph: Record<string, string[]>;
  edge_owners: Array<{
    edge: {
      from_topic: string;
      to_topic: string;
    };
    owner_session_ids: string[];
  }>;
  sessions: Record<
    string,
    {
      edges: Array<{
        from_topic: string;
        to_topic: string;
      }>;
      metadata: Record<string, unknown> | null;
    }
  >;
  processes: Record<string, SnapshotProcess>;
};

export type PublisherProfilingSnapshot = {
  messages_published_window: number;
  publish_rate_hz_window: number;
  backpressure_wait_ns_window: number;
  [key: string]: unknown;
};

export type SubscriberProfilingSnapshot = {
  messages_received_window: number;
  user_span_ns_avg_window: number;
  attributable_backpressure_ns_window: number;
  [key: string]: unknown;
};

export type ProcessProfilingSnapshotPayload = {
  process_id: string;
  pid: number;
  host: string;
  window_seconds: number;
  timestamp: number;
  publishers: Record<string, PublisherProfilingSnapshot>;
  subscribers: Record<string, SubscriberProfilingSnapshot>;
};

export type ProfilingSnapshotPayload = Record<
  string,
  ProcessProfilingSnapshotPayload
>;

export type DashboardSnapshotResponse = {
  snapshot: GraphSnapshotPayload;
  settings: SettingsSnapshotPayload;
  profiling: ProfilingSnapshotPayload;
};

export type HealthResponse = {
  status: string;
  graph_session_active: boolean;
  graph_address: string | null;
};
