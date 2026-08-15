import type {
  DashboardSnapshotResponse,
  HealthResponse,
  ProcessProfilingSnapshotPayload,
  PublisherProfilingSnapshot,
  SubscriberProfilingSnapshot,
  SettingsValuePayload,
} from "../types/api";

export type DashboardFixtureTraceSubscriber = {
  endpointId: string;
  topic: string;
  leaseTimeNsBase: number;
  userSpanNsBase: number;
};

export type DashboardFixtureTraceScenario = {
  processId: string;
  publisherEndpointId: string;
  publisherTopic: string;
  eventIntervalMs: number;
  samplesPerTick: number;
  timestampStepNs: number;
  publishDeltaNsBase: number;
  publishDeltaNsJitter: number;
  subscribers: DashboardFixtureTraceSubscriber[];
};

export type DashboardFixture = {
  name: string;
  health: HealthResponse;
  snapshot: DashboardSnapshotResponse;
  traceScenarios?: DashboardFixtureTraceScenario[];
};

function settingsEntry(
  componentName: string,
  componentType: string,
  structuredValue: Record<string, unknown>,
  patchable = true
): SettingsValuePayload {
  return {
    repr_value: structuredValue,
    structured_value: structuredValue,
    settings_schema: null,
    serialized_present: true,
    patchable,
    patch_error: null,
    component_type: componentType,
    component_name: componentName,
  };
}

function processSnapshot(
  processId: string,
  pid: number,
  units: string[],
  publishers: ProcessProfilingSnapshotPayload["publishers"] = {},
  subscribers: ProcessProfilingSnapshotPayload["subscribers"] = {}
): ProcessProfilingSnapshotPayload {
  return {
    process_id: processId,
    pid,
    host: "fixture-host",
    window_seconds: 2,
    timestamp: 1_711_111_111,
    publishers,
    subscribers,
  };
}

function publisherSnapshot(
  endpointId: string,
  topic: string,
  options: {
    messagesPublishedWindow: number;
    publishRateHzWindow: number;
    inflightCurrent?: number;
    numBuffers?: number;
    messagesPublishedTotal?: number;
    timestamp?: number;
  }
): PublisherProfilingSnapshot {
  return {
    endpoint_id: endpointId,
    topic,
    messages_published_total:
      options.messagesPublishedTotal ?? options.messagesPublishedWindow * 10,
    messages_published_window: options.messagesPublishedWindow,
    publish_rate_hz_window: options.publishRateHzWindow,
    inflight_messages_current: options.inflightCurrent ?? 0,
    num_buffers: options.numBuffers ?? 8,
    timestamp: options.timestamp ?? 1_711_111_111,
  };
}

function subscriberSnapshot(
  endpointId: string,
  topic: string,
  options: {
    messagesReceivedWindow: number;
    messagesReceivedTotal?: number;
    channelKindLast?: string;
    timestamp?: number;
  }
): SubscriberProfilingSnapshot {
  return {
    endpoint_id: endpointId,
    topic,
    messages_received_total:
      options.messagesReceivedTotal ?? options.messagesReceivedWindow * 10,
    messages_received_window: options.messagesReceivedWindow,
    channel_kind_last: options.channelKindLast ?? "fifo",
    timestamp: options.timestamp ?? 1_711_111_111,
  };
}

function inputStream(address: string, msgType = "builtins.str"): Record<string, unknown> {
  return {
    address,
    msg_type: msgType,
    leaky: false,
  };
}

function outputStream(
  address: string,
  port: number,
  msgType = "builtins.str"
): Record<string, unknown> {
  return {
    address,
    msg_type: msgType,
    host: "127.0.0.1",
    port,
  };
}

function taskEntry(name: string, subscribes: string | null, publishes: string[]) {
  return {
    name,
    subscribes,
    publishes,
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

const rootScopeFixture: DashboardFixture = {
  name: "root-scope-navigation",
  health: {
    status: "ok",
    graph_session_active: true,
    graph_address: "127.0.0.1:25978",
  },
  snapshot: {
    snapshot: {
      graph: {
        "SYSTEM/PING_TOPIC": ["GLOBAL_PING_TOPIC"],
      },
      edge_owners: [],
      sessions: {
        "fixture-session": {
          edges: [
            {
              from_topic: "SYSTEM/PING_TOPIC",
              to_topic: "GLOBAL_PING_TOPIC",
            },
          ],
          metadata: {
            components: {
              SYSTEM: {
                name: "SYSTEM",
                component_type: "fixture.TestSystem",
                children: ["SYSTEM/PING"],
                topics: {
                  PING: {
                    address: "SYSTEM/PING_TOPIC",
                    msg_type: "builtins.str",
                  },
                },
              },
              "SYSTEM/PING": {
                name: "PING",
                component_type: "fixture.MessageGenerator",
                streams: {
                  OUTPUT: {
                    address: "SYSTEM/PING_TOPIC:ping-output-endpoint",
                    msg_type: "builtins.str",
                    host: "127.0.0.1",
                    port: 9001,
                  },
                },
                tasks: [
                  {
                    name: "emit",
                    subscribes: null,
                    publishes: ["SYSTEM/PING_TOPIC"],
                  },
                ],
              },
            },
          },
        },
      },
      processes: {
        "fixture-process": {
          process_id: "fixture-process",
          pid: 4201,
          host: "fixture-host",
          units: ["SYSTEM/PING"],
        },
      },
    },
    settings: {
      SYSTEM: settingsEntry("SYSTEM", "fixture.TestSystem", {
        enabled: true,
      }),
      "SYSTEM/PING": settingsEntry("PING", "fixture.MessageGenerator", {
        rate_hz: 10,
        message: "ping",
        // JSON has no infinity literal; non-finite floats travel as tokens.
        timeout_s: "Infinity",
      }),
    },
    profiling: {
      "fixture-process": processSnapshot("fixture-process", 4201, ["SYSTEM/PING"], {
        "SYSTEM/PING_TOPIC:ping-output-endpoint": {
          endpoint_id: "ping-output-endpoint",
          topic: "SYSTEM/PING_TOPIC",
          messages_published_total: 120,
          messages_published_window: 20,
          publish_rate_hz_window: 10,
          inflight_messages_current: 1,
          num_buffers: 8,
          timestamp: 1_711_111_111,
        },
        // Control-plane publisher, created the first time a setting is patched.
        // Idle forever after that; hidden from the pane unless debug is on.
        "SYSTEM/PING/INPUT_SETTINGS:ping-settings-endpoint": {
          endpoint_id: "ping-settings-endpoint",
          topic: "SYSTEM/PING/INPUT_SETTINGS",
          messages_published_total: 1,
          messages_published_window: 0,
          publish_rate_hz_window: 0,
          inflight_messages_current: 0,
          num_buffers: 8,
          timestamp: 1_711_111_111,
        },
      }),
    },
  },
};

const wideFanoutFixture: DashboardFixture = {
  name: "wide-fanout",
  health: rootScopeFixture.health,
  snapshot: {
    snapshot: {
      graph: {
        "STRESS/SOURCE_A": [
          "STRESS/FANOUT_1",
          "STRESS/FANOUT_2",
          "STRESS/FANOUT_3",
          "STRESS/FANOUT_4",
          "STRESS/FANOUT_5",
          "STRESS/FANOUT_6",
        ],
        "STRESS/SOURCE_B": ["STRESS/FANOUT_1", "STRESS/FANOUT_2"],
        "STRESS/FANOUT_1": ["STRESS/SINK_1"],
        "STRESS/FANOUT_2": ["STRESS/SINK_2"],
        "STRESS/FANOUT_3": ["STRESS/SINK_3"],
        "STRESS/FANOUT_4": ["STRESS/SINK_4"],
        "STRESS/FANOUT_5": ["STRESS/SINK_5"],
        "STRESS/FANOUT_6": ["STRESS/SINK_6"],
      },
      edge_owners: [],
      sessions: {
        "wide-session": {
          edges: [],
          metadata: {
            components: {
              STRESS: {
                name: "STRESS",
                component_type: "fixture.StressCollection",
                children: [
                  "STRESS/AGGREGATOR",
                  "STRESS/SINK_1",
                  "STRESS/SINK_2",
                  "STRESS/SINK_3",
                  "STRESS/SINK_4",
                  "STRESS/SINK_5",
                  "STRESS/SINK_6",
                ],
              },
              "STRESS/AGGREGATOR": {
                name: "AGGREGATOR",
                component_type: "fixture.AggregatorUnit",
                streams: {
                  INPUT_ALPHA: {
                    address: "STRESS/SOURCE_A:input-alpha",
                    msg_type: "builtins.str",
                    leaky: false,
                  },
                  INPUT_BETA: {
                    address: "STRESS/SOURCE_B:input-beta",
                    msg_type: "builtins.str",
                    leaky: false,
                  },
                  OUTPUT_1: {
                    address: "STRESS/FANOUT_1:fanout-1",
                    msg_type: "builtins.str",
                    host: "127.0.0.1",
                    port: 9101,
                  },
                  OUTPUT_2: {
                    address: "STRESS/FANOUT_2:fanout-2",
                    msg_type: "builtins.str",
                    host: "127.0.0.1",
                    port: 9102,
                  },
                  OUTPUT_3: {
                    address: "STRESS/FANOUT_3:fanout-3",
                    msg_type: "builtins.str",
                    host: "127.0.0.1",
                    port: 9103,
                  },
                  OUTPUT_4: {
                    address: "STRESS/FANOUT_4:fanout-4",
                    msg_type: "builtins.str",
                    host: "127.0.0.1",
                    port: 9104,
                  },
                  OUTPUT_5: {
                    address: "STRESS/FANOUT_5:fanout-5",
                    msg_type: "builtins.str",
                    host: "127.0.0.1",
                    port: 9105,
                  },
                  OUTPUT_6: {
                    address: "STRESS/FANOUT_6:fanout-6",
                    msg_type: "builtins.str",
                    host: "127.0.0.1",
                    port: 9106,
                  },
                },
                tasks: [
                  {
                    name: "normalize_payload",
                    subscribes: "STRESS/SOURCE_A",
                    publishes: ["STRESS/FANOUT_1", "STRESS/FANOUT_2"],
                  },
                  {
                    name: "deduplicate_messages",
                    subscribes: "STRESS/SOURCE_B",
                    publishes: ["STRESS/FANOUT_3", "STRESS/FANOUT_4"],
                  },
                  {
                    name: "route_priority_messages",
                    subscribes: "STRESS/SOURCE_A",
                    publishes: ["STRESS/FANOUT_5", "STRESS/FANOUT_6"],
                  },
                ],
              },
              ...Object.fromEntries(
                Array.from({ length: 6 }, (_, index) => {
                  const sinkIndex = index + 1;
                  return [
                    `STRESS/SINK_${sinkIndex}`,
                    {
                      name: `SINK_${sinkIndex}`,
                      component_type: "fixture.DebugOutput",
                      streams: {
                        INPUT: {
                          address: `STRESS/FANOUT_${sinkIndex}:sink-${sinkIndex}`,
                          msg_type: "builtins.str",
                          leaky: false,
                        },
                      },
                      tasks: [
                        {
                          name: "on_message",
                          subscribes: `STRESS/FANOUT_${sinkIndex}`,
                          publishes: [],
                        },
                      ],
                    },
                  ];
                })
              ),
            },
          },
        },
      },
      processes: {
        "wide-process": {
          process_id: "wide-process",
          pid: 4301,
          host: "fixture-host",
          units: [
            "STRESS/AGGREGATOR",
            "STRESS/SINK_1",
            "STRESS/SINK_2",
            "STRESS/SINK_3",
            "STRESS/SINK_4",
            "STRESS/SINK_5",
            "STRESS/SINK_6",
          ],
        },
      },
    },
    settings: {
      STRESS: settingsEntry("STRESS", "fixture.StressCollection", {
        mode: "stress",
      }),
      "STRESS/AGGREGATOR": settingsEntry("AGGREGATOR", "fixture.AggregatorUnit", {
        batch_size: 64,
        strategy: "spread",
      }),
    },
    profiling: {
      "wide-process": processSnapshot("wide-process", 4301, [
        "STRESS/AGGREGATOR",
      ]),
    },
  },
};

const longLabelsFixture: DashboardFixture = {
  name: "long-labels",
  health: rootScopeFixture.health,
  snapshot: {
    snapshot: {
      graph: {
        "LONG_SCOPE/EXTRAORDINARILY_VERBOSE_PUBLISHER_TOPIC_NAME": [
          "LONG_SCOPE/ULTRA_VERBOSE_SUBSCRIBER_TOPIC_NAME",
        ],
      },
      edge_owners: [],
      sessions: {
        "long-session": {
          edges: [],
          metadata: {
            components: {
              LONG_SCOPE: {
                name: "EXTRAORDINARILY_VERBOSE_COLLECTION_NAME_FOR_LAYOUT_TESTING",
                component_type: "fixture.deep.namespace.ExtremelyLongCollectionComponentType",
                children: ["LONG_SCOPE/COMPONENT_WITH_EXCEPTIONALLY_LONG_NAME"],
              },
              "LONG_SCOPE/COMPONENT_WITH_EXCEPTIONALLY_LONG_NAME": {
                name: "COMPONENT_WITH_EXCEPTIONALLY_LONG_NAME",
                component_type:
                  "fixture.deep.namespace.componenttypes.ExceptionallyLongComponentTypeName",
                streams: {
                  OUTPUT_WITH_A_LONG_NAME: {
                    address:
                      "LONG_SCOPE/EXTRAORDINARILY_VERBOSE_PUBLISHER_TOPIC_NAME:publisher-endpoint-with-a-very-long-token",
                    msg_type: "fixtures.messages.ReallyLongStructuredMessageTypeName",
                    host: "127.0.0.1",
                    port: 9201,
                  },
                  INPUT_WITH_A_LONG_NAME: {
                    address:
                      "LONG_SCOPE/ULTRA_VERBOSE_SUBSCRIBER_TOPIC_NAME:subscriber-endpoint-with-a-very-long-token",
                    msg_type: "fixtures.messages.ReallyLongStructuredMessageTypeName",
                    leaky: false,
                  },
                },
                tasks: [
                  {
                    name: "task_with_a_surprisingly_long_name_for_a_single_render_chip",
                    subscribes: "LONG_SCOPE/ULTRA_VERBOSE_SUBSCRIBER_TOPIC_NAME",
                    publishes: ["LONG_SCOPE/EXTRAORDINARILY_VERBOSE_PUBLISHER_TOPIC_NAME"],
                  },
                ],
              },
            },
          },
        },
      },
      processes: {
        "long-process": {
          process_id: "long-process",
          pid: 4401,
          host: "fixture-host",
          units: ["LONG_SCOPE/COMPONENT_WITH_EXCEPTIONALLY_LONG_NAME"],
        },
      },
    },
    settings: {
      LONG_SCOPE: settingsEntry(
        "EXTRAORDINARILY_VERBOSE_COLLECTION_NAME_FOR_LAYOUT_TESTING",
        "fixture.deep.namespace.ExtremelyLongCollectionComponentType",
        { debug_mode_enabled: true }
      ),
      "LONG_SCOPE/COMPONENT_WITH_EXCEPTIONALLY_LONG_NAME": settingsEntry(
        "COMPONENT_WITH_EXCEPTIONALLY_LONG_NAME",
        "fixture.deep.namespace.componenttypes.ExceptionallyLongComponentTypeName",
        {
          default_payload:
            "the_quick_brown_fox_jumps_over_the_lazy_dog_repeatedly_to_stress_text_overflow",
        }
      ),
    },
    profiling: {
      "long-process": processSnapshot("long-process", 4401, [
        "LONG_SCOPE/COMPONENT_WITH_EXCEPTIONALLY_LONG_NAME",
      ]),
    },
  },
};

const semanticStreamNamesFixture: DashboardFixture = {
  name: "semantic-stream-names",
  health: rootScopeFixture.health,
  snapshot: {
    snapshot: {
      graph: {
        "SIN/OUTPUT_SIGNAL_TOPIC": ["SIN/WAVEFORM_TOPIC"],
      },
      edge_owners: [],
      sessions: {
        "semantic-stream-session": {
          edges: [],
          metadata: {
            components: {
              SIN: {
                name: "SIN",
                component_type: "fixture.LFO",
                streams: {
                  INPUT_SIGNAL: inputStream(
                    "SIN/INPUT_SIGNAL_TOPIC:sin-input-signal",
                    "fixtures.array.AxisArray"
                  ),
                  INPUT_SETTINGS: inputStream(
                    "SIN/INPUT_SETTINGS_TOPIC:sin-input-settings",
                    "fixtures.config.LFOSettings"
                  ),
                  OUTPUT_SIGNAL: outputStream(
                    "SIN/OUTPUT_SIGNAL_TOPIC:sin-output-signal",
                    9211,
                    "fixtures.array.AxisArray"
                  ),
                },
                tasks: [
                  taskEntry("on_signal", "SIN/INPUT_SIGNAL_TOPIC", []),
                  taskEntry("on_settings", "SIN/INPUT_SETTINGS_TOPIC", []),
                  taskEntry("generate", null, ["SIN/OUTPUT_SIGNAL_TOPIC"]),
                ],
              },
            },
          },
        },
      },
      processes: {
        "semantic-stream-process": {
          process_id: "semantic-stream-process",
          pid: 4451,
          host: "fixture-host",
          units: ["SIN"],
        },
      },
    },
    settings: {
      SIN: settingsEntry("SIN", "fixture.LFO", {
        freq: 1.5,
        update_rate: 60,
      }),
    },
    profiling: {
      "semantic-stream-process": processSnapshot("semantic-stream-process", 4451, ["SIN"]),
    },
  },
};

const sparseTraceSubscriberAddresses = Array.from(
  { length: 6 },
  (_, index) => `TRACE_LAB/SPARSE_SUB_${pad2(index + 1)}`
);
const denseTraceSubscriberAddresses = Array.from(
  { length: 8 },
  (_, index) => `TRACE_LAB/DENSE_SUB_${pad2(index + 1)}`
);

const profilingTraceFixture: DashboardFixture = {
  name: "profiling-trace-rates",
  health: rootScopeFixture.health,
  snapshot: {
    snapshot: {
      graph: Object.fromEntries([
        [
          "TRACE_LAB/SPARSE_TOPIC",
          sparseTraceSubscriberAddresses.map(
            (_, index) => `TRACE_LAB/SPARSE_SUB_${pad2(index + 1)}_TOPIC`
          ),
        ],
        [
          "TRACE_LAB/DENSE_TOPIC",
          denseTraceSubscriberAddresses.map(
            (_, index) => `TRACE_LAB/DENSE_SUB_${pad2(index + 1)}_TOPIC`
          ),
        ],
      ]),
      edge_owners: [],
      sessions: {
        "trace-session": {
          edges: [],
          metadata: {
            components: {
              TRACE_LAB: {
                name: "TRACE_LAB",
                component_type: "fixture.TraceLabCollection",
                children: [
                  "TRACE_LAB/SPARSE_PUB",
                  "TRACE_LAB/DENSE_PUB",
                  ...sparseTraceSubscriberAddresses,
                  ...denseTraceSubscriberAddresses,
                ],
              },
              "TRACE_LAB/SPARSE_PUB": {
                name: "SPARSE_PUB",
                component_type: "fixture.TracePublisherUnit",
                streams: {
                  OUTPUT: outputStream(
                    "TRACE_LAB/SPARSE_TOPIC:sparse-publisher-endpoint",
                    9901
                  ),
                },
                tasks: [
                  taskEntry("publish_sparse", null, ["TRACE_LAB/SPARSE_TOPIC"]),
                ],
              },
              "TRACE_LAB/DENSE_PUB": {
                name: "DENSE_PUB",
                component_type: "fixture.TracePublisherUnit",
                streams: {
                  OUTPUT: outputStream(
                    "TRACE_LAB/DENSE_TOPIC:dense-publisher-endpoint",
                    9902
                  ),
                },
                tasks: [
                  taskEntry("publish_dense", null, ["TRACE_LAB/DENSE_TOPIC"]),
                ],
              },
              ...Object.fromEntries(
                sparseTraceSubscriberAddresses.map((address, index) => {
                  const lane = pad2(index + 1);
                  return [
                    address,
                    {
                      name: `SPARSE_SUB_${lane}`,
                      component_type: "fixture.TraceSubscriberUnit",
                      streams: {
                        INPUT: inputStream(
                          `TRACE_LAB/SPARSE_SUB_${lane}_TOPIC:sparse-subscriber-${lane}`
                        ),
                      },
                      tasks: [
                        taskEntry(
                          `consume_sparse_${lane}`,
                          `TRACE_LAB/SPARSE_SUB_${lane}_TOPIC`,
                          []
                        ),
                      ],
                    },
                  ];
                })
              ),
              ...Object.fromEntries(
                denseTraceSubscriberAddresses.map((address, index) => {
                  const lane = pad2(index + 1);
                  return [
                    address,
                    {
                      name: `DENSE_SUB_${lane}`,
                      component_type: "fixture.TraceSubscriberUnit",
                      streams: {
                        INPUT: inputStream(
                          `TRACE_LAB/DENSE_SUB_${lane}_TOPIC:dense-subscriber-${lane}`
                        ),
                      },
                      tasks: [
                        taskEntry(
                          `consume_dense_${lane}`,
                          `TRACE_LAB/DENSE_SUB_${lane}_TOPIC`,
                          []
                        ),
                      ],
                    },
                  ];
                })
              ),
            },
          },
        },
      },
      processes: {
        "trace-process": {
          process_id: "trace-process",
          pid: 5001,
          host: "fixture-host",
          units: [
            "TRACE_LAB/SPARSE_PUB",
            "TRACE_LAB/DENSE_PUB",
            ...sparseTraceSubscriberAddresses,
            ...denseTraceSubscriberAddresses,
          ],
        },
      },
    },
    settings: {
      TRACE_LAB: settingsEntry("TRACE_LAB", "fixture.TraceLabCollection", {
        trace_enabled: true,
      }),
      "TRACE_LAB/SPARSE_PUB": settingsEntry("SPARSE_PUB", "fixture.TracePublisherUnit", {
        publish_rate_hz: 1,
      }),
      "TRACE_LAB/DENSE_PUB": settingsEntry("DENSE_PUB", "fixture.TracePublisherUnit", {
        publish_rate_hz: 60,
      }),
    },
    profiling: {
      "trace-process": processSnapshot(
        "trace-process",
        5001,
        [
          "TRACE_LAB/SPARSE_PUB",
          "TRACE_LAB/DENSE_PUB",
          ...sparseTraceSubscriberAddresses,
          ...denseTraceSubscriberAddresses,
        ],
        {
          "TRACE_LAB/SPARSE_TOPIC:sparse-publisher-endpoint": publisherSnapshot(
            "sparse-publisher-endpoint",
            "TRACE_LAB/SPARSE_TOPIC",
            {
              messagesPublishedWindow: 2,
              publishRateHzWindow: 1,
              numBuffers: 4,
            }
          ),
          "TRACE_LAB/DENSE_TOPIC:dense-publisher-endpoint": publisherSnapshot(
            "dense-publisher-endpoint",
            "TRACE_LAB/DENSE_TOPIC",
            {
              messagesPublishedWindow: 120,
              publishRateHzWindow: 60,
              inflightCurrent: 2,
              numBuffers: 16,
            }
          ),
        },
        {
          ...Object.fromEntries(
            sparseTraceSubscriberAddresses.map((_, index) => {
              const lane = pad2(index + 1);
              return [
                `TRACE_LAB/SPARSE_SUB_${lane}_TOPIC:sparse-subscriber-${lane}`,
                subscriberSnapshot(
                  `sparse-subscriber-${lane}`,
                  `TRACE_LAB/SPARSE_SUB_${lane}_TOPIC`,
                  {
                    messagesReceivedWindow: 2,
                    channelKindLast: index % 2 === 0 ? "fifo" : "shared_memory",
                  }
                ),
              ];
            })
          ),
          ...Object.fromEntries(
            denseTraceSubscriberAddresses.map((_, index) => {
              const lane = pad2(index + 1);
              return [
                `TRACE_LAB/DENSE_SUB_${lane}_TOPIC:dense-subscriber-${lane}`,
                subscriberSnapshot(
                  `dense-subscriber-${lane}`,
                  `TRACE_LAB/DENSE_SUB_${lane}_TOPIC`,
                  {
                    messagesReceivedWindow: 120,
                    channelKindLast:
                      index < 3 ? "tcp" : index % 2 === 0 ? "fifo" : "shared_memory",
                  }
                ),
              ];
            })
          ),
        }
      ),
    },
  },
  traceScenarios: [
    {
      processId: "trace-process",
      publisherEndpointId: "sparse-publisher-endpoint",
      publisherTopic: "TRACE_LAB/SPARSE_TOPIC",
      eventIntervalMs: 140,
      samplesPerTick: 1,
      timestampStepNs: 1_000_000_000,
      publishDeltaNsBase: 940_000_000,
      publishDeltaNsJitter: 120_000_000,
      subscribers: sparseTraceSubscriberAddresses.map((_, index) => {
        const lane = pad2(index + 1);
        return {
          endpointId: `sparse-subscriber-${lane}`,
          topic: `TRACE_LAB/SPARSE_SUB_${lane}_TOPIC`,
          leaseTimeNsBase: 7_000_000 + index * 800_000,
          userSpanNsBase: 2_500_000 + index * 240_000,
        };
      }),
    },
    {
      processId: "trace-process",
      publisherEndpointId: "dense-publisher-endpoint",
      publisherTopic: "TRACE_LAB/DENSE_TOPIC",
      eventIntervalMs: 100,
      samplesPerTick: 12,
      timestampStepNs: 16_666_667,
      publishDeltaNsBase: 16_400_000,
      publishDeltaNsJitter: 2_400_000,
      subscribers: denseTraceSubscriberAddresses.map((_, index) => {
        const lane = pad2(index + 1);
        return {
          endpointId: `dense-subscriber-${lane}`,
          topic: `TRACE_LAB/DENSE_SUB_${lane}_TOPIC`,
          leaseTimeNsBase: 1_300_000 + index * 140_000,
          userSpanNsBase: 920_000 + index * 110_000,
        };
      }),
    },
  ],
};

const nestedCollectionsFixture: DashboardFixture = {
  name: "nested-collections",
  health: rootScopeFixture.health,
  snapshot: {
    snapshot: {
      graph: {
        "LAB/PIPELINE/ROOT_TOPIC": ["LAB/PIPELINE/INNER/INNER_TOPIC"],
        "LAB/PIPELINE/INNER/INNER_TOPIC": ["LAB/PIPELINE/LEAF_TOPIC"],
      },
      edge_owners: [],
      sessions: {
        "nested-session": {
          edges: [],
          metadata: {
            components: {
              LAB: {
                name: "LAB",
                component_type: "fixture.RootCollection",
                children: ["LAB/PIPELINE"],
              },
              "LAB/PIPELINE": {
                name: "PIPELINE",
                component_type: "fixture.PipelineCollection",
                children: [
                  "LAB/PIPELINE/SOURCE",
                  "LAB/PIPELINE/INNER",
                ],
                topics: {
                  ROOT_TOPIC: {
                    address: "LAB/PIPELINE/ROOT_TOPIC",
                    msg_type: "builtins.str",
                  },
                },
              },
              "LAB/PIPELINE/INNER": {
                name: "INNER",
                component_type: "fixture.InnerCollection",
                children: ["LAB/PIPELINE/INNER/SINK"],
                topics: {
                  INNER_TOPIC: {
                    address: "LAB/PIPELINE/INNER/INNER_TOPIC",
                    msg_type: "builtins.str",
                  },
                },
              },
              "LAB/PIPELINE/SOURCE": {
                name: "SOURCE",
                component_type: "fixture.SourceUnit",
                streams: {
                  OUTPUT: {
                    address: "LAB/PIPELINE/ROOT_TOPIC:source-output",
                    msg_type: "builtins.str",
                    host: "127.0.0.1",
                    port: 9301,
                  },
                },
                tasks: [
                  {
                    name: "emit_root_topic",
                    subscribes: null,
                    publishes: ["LAB/PIPELINE/ROOT_TOPIC"],
                  },
                ],
              },
              "LAB/PIPELINE/INNER/SINK": {
                name: "SINK",
                component_type: "fixture.SinkUnit",
                streams: {
                  INPUT: {
                    address: "LAB/PIPELINE/INNER/INNER_TOPIC:inner-input",
                    msg_type: "builtins.str",
                    leaky: false,
                  },
                  OUTPUT: {
                    address: "LAB/PIPELINE/LEAF_TOPIC:leaf-output",
                    msg_type: "builtins.str",
                    host: "127.0.0.1",
                    port: 9302,
                  },
                },
                tasks: [
                  {
                    name: "relay_nested_topic",
                    subscribes: "LAB/PIPELINE/INNER/INNER_TOPIC",
                    publishes: ["LAB/PIPELINE/LEAF_TOPIC"],
                  },
                ],
              },
              "CONTROL/PROBE": {
                name: "PROBE",
                component_type: "fixture.RootProbe",
                streams: {
                  OUTPUT: {
                    address: "CONTROL/PROBE_TOPIC:probe-output",
                    msg_type: "builtins.str",
                    host: "127.0.0.1",
                    port: 9303,
                  },
                },
                tasks: [
                  {
                    name: "probe_root_scope",
                    subscribes: null,
                    publishes: ["CONTROL/PROBE_TOPIC"],
                  },
                ],
              },
            },
          },
        },
      },
      processes: {
        "nested-process": {
          process_id: "nested-process",
          pid: 4501,
          host: "fixture-host",
          units: [
            "LAB/PIPELINE/SOURCE",
            "LAB/PIPELINE/INNER/SINK",
            "CONTROL/PROBE",
          ],
        },
      },
    },
    settings: {
      LAB: settingsEntry("LAB", "fixture.RootCollection", {
        enabled: true,
      }),
      "LAB/PIPELINE": settingsEntry("PIPELINE", "fixture.PipelineCollection", {
        stage_count: 2,
      }),
      "LAB/PIPELINE/INNER": settingsEntry("INNER", "fixture.InnerCollection", {
        nested: true,
      }),
    },
    profiling: {
      "nested-process": processSnapshot("nested-process", 4501, [
        "LAB/PIPELINE/SOURCE",
        "LAB/PIPELINE/INNER/SINK",
      ]),
    },
  },
};

const orphanStreamsFixture: DashboardFixture = {
  name: "orphan-streams",
  health: rootScopeFixture.health,
  snapshot: {
    snapshot: {
      graph: {
        "ORPHAN/INPUT_TOPIC": ["SYSTEM/PROCESS_TOPIC"],
        "SYSTEM/PROCESS_TOPIC": ["ORPHAN/OUTPUT_TOPIC"],
      },
      edge_owners: [],
      sessions: {
        "orphan-session": {
          edges: [],
          metadata: {
            components: {
              "SYSTEM/PROCESSOR": {
                name: "PROCESSOR",
                component_type: "fixture.ProcessorUnit",
                streams: {
                  INPUT: {
                    address: "SYSTEM/PROCESS_TOPIC:processor-input",
                    msg_type: "builtins.str",
                    leaky: false,
                  },
                  OUTPUT: {
                    address: "SYSTEM/PROCESS_TOPIC:processor-output",
                    msg_type: "builtins.str",
                    host: "127.0.0.1",
                    port: 9401,
                  },
                },
                tasks: [
                  {
                    name: "transform_orphan_stream",
                    subscribes: "SYSTEM/PROCESS_TOPIC",
                    publishes: ["SYSTEM/PROCESS_TOPIC"],
                  },
                ],
              },
            },
          },
        },
      },
      processes: {
        "orphan-process": {
          process_id: "orphan-process",
          pid: 4601,
          host: "fixture-host",
          units: ["SYSTEM/PROCESSOR"],
        },
      },
    },
    settings: {
      "SYSTEM/PROCESSOR": settingsEntry("PROCESSOR", "fixture.ProcessorUnit", {
        amplify: 2,
      }),
    },
    profiling: {
      "orphan-process": processSnapshot("orphan-process", 4601, [
        "SYSTEM/PROCESSOR",
      ]),
    },
  },
};

const denseUnitLaneCount = 12;
const denseUnitFixture: DashboardFixture = {
  name: "dense-unit-layout",
  health: rootScopeFixture.health,
  snapshot: {
    snapshot: {
      graph: Object.fromEntries(
        Array.from({ length: denseUnitLaneCount }, (_, index) => {
          const lane = pad2(index + 1);
          return [`MATRIX/IN_${lane}_TOPIC`, [`MATRIX/OUT_${lane}_TOPIC`]];
        })
      ),
      edge_owners: [],
      sessions: {
        "dense-unit-session": {
          edges: [],
          metadata: {
            components: {
              MATRIX: {
                name: "MATRIX",
                component_type: "fixture.MatrixCollection",
                children: ["MATRIX/ROUTER"],
              },
              "MATRIX/ROUTER": {
                name: "ROUTER",
                component_type: "fixture.DenseRouter",
                streams: Object.fromEntries([
                  ...Array.from({ length: denseUnitLaneCount }, (_, index) => {
                    const lane = pad2(index + 1);
                    return [
                      `INPUT_${lane}`,
                      inputStream(`MATRIX/IN_${lane}_TOPIC:router-input-${lane}`),
                    ];
                  }),
                  ...Array.from({ length: denseUnitLaneCount }, (_, index) => {
                    const lane = pad2(index + 1);
                    return [
                      `OUTPUT_${lane}`,
                      outputStream(`MATRIX/OUT_${lane}_TOPIC:router-output-${lane}`, 9500 + index),
                    ];
                  }),
                ]),
                tasks: Array.from({ length: denseUnitLaneCount }, (_, index) => {
                  const lane = pad2(index + 1);
                  return taskEntry(`route_lane_${lane}`, `MATRIX/IN_${lane}_TOPIC`, [
                    `MATRIX/OUT_${lane}_TOPIC`,
                  ]);
                }),
              },
            },
          },
        },
      },
      processes: {
        "dense-unit-process": {
          process_id: "dense-unit-process",
          pid: 4701,
          host: "fixture-host",
          units: ["MATRIX/ROUTER"],
        },
      },
    },
    settings: {
      MATRIX: settingsEntry("MATRIX", "fixture.MatrixCollection", {
        lanes: denseUnitLaneCount,
      }),
      "MATRIX/ROUTER": settingsEntry("ROUTER", "fixture.DenseRouter", {
        lanes: denseUnitLaneCount,
        parallelism: 4,
      }),
    },
    profiling: {
      "dense-unit-process": processSnapshot("dense-unit-process", 4701, ["MATRIX/ROUTER"]),
    },
  },
};

const megaFanoutLaneCount = 12;
const megaSourceAddresses = Array.from(
  { length: megaFanoutLaneCount },
  (_, index) => `MEGA/SRC_${pad2(index + 1)}`
);
const megaSinkAddresses = Array.from(
  { length: megaFanoutLaneCount },
  (_, index) => `MEGA/SINK_${pad2(index + 1)}`
);
const massiveFanoutFixture: DashboardFixture = {
  name: "massive-fanout",
  health: rootScopeFixture.health,
  snapshot: {
    snapshot: {
      graph: Object.fromEntries([
        ...Array.from({ length: megaFanoutLaneCount }, (_, index) => {
          const lane = pad2(index + 1);
          return [`MEGA/SRC_${lane}_TOPIC`, [`MEGA/HUB_IN_${lane}_TOPIC`]];
        }),
        ...Array.from({ length: megaFanoutLaneCount }, (_, index) => {
          const lane = pad2(index + 1);
          return [`MEGA/HUB_OUT_${lane}_TOPIC`, [`MEGA/SINK_${lane}_IN_TOPIC`]];
        }),
      ]),
      edge_owners: [],
      sessions: {
        "mega-session": {
          edges: [],
          metadata: {
            components: {
              MEGA: {
                name: "MEGA",
                component_type: "fixture.MegaScope",
                children: [
                  ...megaSourceAddresses,
                  "MEGA/HUB",
                  ...megaSinkAddresses,
                ],
              },
              ...Object.fromEntries(
                megaSourceAddresses.map((address, index) => {
                  const lane = pad2(index + 1);
                  return [
                    address,
                    {
                      name: `SRC_${lane}`,
                      component_type: "fixture.SourceUnit",
                      streams: {
                        OUTPUT: outputStream(
                          `MEGA/SRC_${lane}_TOPIC:source-output-${lane}`,
                          9600 + index
                        ),
                      },
                      tasks: [
                        taskEntry(`emit_lane_${lane}`, null, [`MEGA/SRC_${lane}_TOPIC`]),
                      ],
                    },
                  ];
                })
              ),
              "MEGA/HUB": {
                name: "HUB",
                component_type: "fixture.HubRouter",
                streams: Object.fromEntries([
                  ...Array.from({ length: megaFanoutLaneCount }, (_, index) => {
                    const lane = pad2(index + 1);
                    return [
                      `INPUT_${lane}`,
                      inputStream(`MEGA/HUB_IN_${lane}_TOPIC:hub-input-${lane}`),
                    ];
                  }),
                  ...Array.from({ length: megaFanoutLaneCount }, (_, index) => {
                    const lane = pad2(index + 1);
                    return [
                      `OUTPUT_${lane}`,
                      outputStream(`MEGA/HUB_OUT_${lane}_TOPIC:hub-output-${lane}`, 9700 + index),
                    ];
                  }),
                ]),
                tasks: Array.from({ length: megaFanoutLaneCount }, (_, index) => {
                  const lane = pad2(index + 1);
                  return taskEntry(`fanout_lane_${lane}`, `MEGA/HUB_IN_${lane}_TOPIC`, [
                    `MEGA/HUB_OUT_${lane}_TOPIC`,
                  ]);
                }),
              },
              ...Object.fromEntries(
                megaSinkAddresses.map((address, index) => {
                  const lane = pad2(index + 1);
                  return [
                    address,
                    {
                      name: `SINK_${lane}`,
                      component_type: "fixture.SinkUnit",
                      streams: {
                        INPUT: inputStream(`MEGA/SINK_${lane}_IN_TOPIC:sink-input-${lane}`),
                      },
                      tasks: [
                        taskEntry(`consume_lane_${lane}`, `MEGA/SINK_${lane}_IN_TOPIC`, []),
                      ],
                    },
                  ];
                })
              ),
            },
          },
        },
      },
      processes: {
        "mega-process": {
          process_id: "mega-process",
          pid: 4801,
          host: "fixture-host",
          units: [...megaSourceAddresses, "MEGA/HUB", ...megaSinkAddresses],
        },
      },
    },
    settings: {
      MEGA: settingsEntry("MEGA", "fixture.MegaScope", {
        lanes: megaFanoutLaneCount,
      }),
      "MEGA/HUB": settingsEntry("HUB", "fixture.HubRouter", {
        lanes: megaFanoutLaneCount,
        fanout_mode: "parallel",
      }),
    },
    profiling: {
      "mega-process": processSnapshot("mega-process", 4801, [
        ...megaSourceAddresses,
        "MEGA/HUB",
        ...megaSinkAddresses,
      ]),
    },
  },
};

const cyclicFeedbackFixture: DashboardFixture = {
  name: "cyclic-feedback",
  health: rootScopeFixture.health,
  snapshot: {
    snapshot: {
      graph: {
        "ALPHA/OUT_TOPIC": ["BETA/IN_TOPIC"],
        "BETA/OUT_TOPIC": ["GAMMA/IN_TOPIC"],
        "GAMMA/OUT_TOPIC": ["ALPHA/IN_TOPIC"],
        "GAMMA/AUDIT_TOPIC": ["MONITOR/IN_TOPIC"],
      },
      edge_owners: [],
      sessions: {
        "cycle-session": {
          edges: [],
          metadata: {
            components: {
              ALPHA: {
                name: "ALPHA",
                component_type: "fixture.FeedbackStage",
                streams: {
                  INPUT: inputStream("ALPHA/IN_TOPIC:alpha-input"),
                  OUTPUT: outputStream("ALPHA/OUT_TOPIC:alpha-output", 9801),
                },
                tasks: [
                  taskEntry("forward_alpha", "ALPHA/IN_TOPIC", ["ALPHA/OUT_TOPIC"]),
                ],
              },
              BETA: {
                name: "BETA",
                component_type: "fixture.FeedbackStage",
                streams: {
                  INPUT: inputStream("BETA/IN_TOPIC:beta-input"),
                  OUTPUT: outputStream("BETA/OUT_TOPIC:beta-output", 9802),
                },
                tasks: [
                  taskEntry("forward_beta", "BETA/IN_TOPIC", ["BETA/OUT_TOPIC"]),
                ],
              },
              GAMMA: {
                name: "GAMMA",
                component_type: "fixture.FeedbackStage",
                streams: {
                  INPUT: inputStream("GAMMA/IN_TOPIC:gamma-input"),
                  OUTPUT: outputStream("GAMMA/OUT_TOPIC:gamma-output", 9803),
                  OUTPUT_AUDIT: outputStream("GAMMA/AUDIT_TOPIC:gamma-audit", 9804),
                },
                tasks: [
                  taskEntry("fanout_gamma", "GAMMA/IN_TOPIC", [
                    "GAMMA/OUT_TOPIC",
                    "GAMMA/AUDIT_TOPIC",
                  ]),
                ],
              },
              MONITOR: {
                name: "MONITOR",
                component_type: "fixture.MonitorUnit",
                streams: {
                  INPUT: inputStream("MONITOR/IN_TOPIC:monitor-input"),
                },
                tasks: [
                  taskEntry("observe_cycle", "MONITOR/IN_TOPIC", []),
                ],
              },
            },
          },
        },
      },
      processes: {
        "cycle-process": {
          process_id: "cycle-process",
          pid: 4901,
          host: "fixture-host",
          units: ["ALPHA", "BETA", "GAMMA", "MONITOR"],
        },
      },
    },
    settings: {
      ALPHA: settingsEntry("ALPHA", "fixture.FeedbackStage", {
        gain: 1,
      }),
      GAMMA: settingsEntry("GAMMA", "fixture.FeedbackStage", {
        audit_enabled: true,
      }),
    },
    profiling: {
      "cycle-process": processSnapshot("cycle-process", 4901, [
        "ALPHA",
        "BETA",
        "GAMMA",
        "MONITOR",
      ]),
    },
  },
};

export const dashboardFixtures: Record<string, DashboardFixture> = {
  "root-scope-navigation": rootScopeFixture,
  "wide-fanout": wideFanoutFixture,
  "long-labels": longLabelsFixture,
  "semantic-stream-names": semanticStreamNamesFixture,
  "profiling-trace-rates": profilingTraceFixture,
  "nested-collections": nestedCollectionsFixture,
  "orphan-streams": orphanStreamsFixture,
  "dense-unit-layout": denseUnitFixture,
  "massive-fanout": massiveFanoutFixture,
  "cyclic-feedback": cyclicFeedbackFixture,
};

export function getDashboardFixture(name: string | null): DashboardFixture | null {
  if (!name) {
    return null;
  }
  return dashboardFixtures[name] ?? null;
}
