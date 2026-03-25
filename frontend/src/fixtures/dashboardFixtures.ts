import type {
  DashboardSnapshotResponse,
  HealthResponse,
  ProcessProfilingSnapshotPayload,
  SettingsValuePayload,
} from "../types/api";

export type DashboardFixture = {
  name: string;
  health: HealthResponse;
  snapshot: DashboardSnapshotResponse;
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
      }),
    },
    profiling: {
      "fixture-process": processSnapshot("fixture-process", 4201, ["SYSTEM/PING"], {
        "SYSTEM/PING_TOPIC:ping-output-endpoint": {
          endpoint_id: "ping-output-endpoint",
          topic: "SYSTEM/PING_TOPIC",
          messages_published_total: 120,
          messages_published_window: 20,
          publish_delta_ns_avg_window: 1_500_000,
          publish_rate_hz_window: 10,
          inflight_messages_current: 1,
          num_buffers: 8,
          inflight_messages_peak_window: 2,
          backpressure_wait_ns_total: 2_000_000,
          backpressure_wait_ns_window: 500_000,
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

export const dashboardFixtures: Record<string, DashboardFixture> = {
  "root-scope-navigation": rootScopeFixture,
  "wide-fanout": wideFanoutFixture,
  "long-labels": longLabelsFixture,
};

export function getDashboardFixture(name: string | null): DashboardFixture | null {
  if (!name) {
    return null;
  }
  return dashboardFixtures[name] ?? null;
}
