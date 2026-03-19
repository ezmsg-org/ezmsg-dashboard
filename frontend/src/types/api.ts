export type SettingsSchemaField = {
  name: string;
  field_type: string;
  required: boolean;
  default: unknown;
  description: string | null;
  bounds: [number | null, number | null] | null;
  choices: unknown[] | null;
  widget_hint: string | null;
};

export type SettingsSchemaPayload = {
  provider: string;
  settings_type: string;
  fields: SettingsSchemaField[];
};

export type SettingsValuePayload = {
  repr_value: Record<string, unknown> | string;
  structured_value: Record<string, unknown> | null;
  settings_schema: SettingsSchemaPayload | null;
  serialized_present: boolean;
  patchable?: boolean;
  patch_error?: string | null;
  component_type?: string | null;
  component_name?: string | null;
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
  endpoint_id: string;
  topic: string;
  messages_published_total: number;
  messages_published_window: number;
  publish_delta_ns_avg_window: number;
  publish_rate_hz_window: number;
  inflight_messages_current: number;
  num_buffers: number;
  inflight_messages_peak_window: number;
  backpressure_wait_ns_total: number;
  backpressure_wait_ns_window: number;
  timestamp: number;
  [key: string]: unknown;
};

export type SubscriberProfilingSnapshot = {
  endpoint_id: string;
  topic: string;
  messages_received_total: number;
  messages_received_window: number;
  lease_time_ns_total: number;
  lease_time_ns_avg_window: number;
  user_span_ns_total: number;
  user_span_ns_avg_window: number;
  attributable_backpressure_ns_total: number;
  attributable_backpressure_ns_window: number;
  attributable_backpressure_events_total: number;
  channel_kind_last: string;
  timestamp: number;
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

export type SettingsFieldPatchRequest = {
  field_path: string;
  value: unknown;
  timeout?: number;
};

export type SettingsFieldPatchResponse = {
  component_address: string;
  field_path: string;
  updated_value: SettingsValuePayload;
};
