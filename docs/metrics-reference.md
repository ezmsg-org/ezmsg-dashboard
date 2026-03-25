# Metrics Reference

This document explains the metrics currently surfaced in the dashboard UI.

The dashboard uses a mix of:

- **snapshot metrics**: values from the latest profiling snapshot window
- **trace metrics**: time-series samples shown in the trace dock

Units in the UI are generally shown in:

- **Hz** for rates
- **ms** for timing values that originate as nanoseconds

## Publisher Metrics

### Rate

How fast a publisher is currently publishing during the active profiling window.

- Source field: `publish_rate_hz_window`
- Displayed as: `Hz`
- Interpretation:
  - higher means the publisher is producing messages more frequently
  - very low or zero may indicate an idle publisher, a stalled publisher, or simply a quiet workload

### Backpressure

The total publisher-side backpressure wait accumulated during the current profiling window.

- Source field: `backpressure_wait_ns_window`
- Displayed as: milliseconds
- Interpretation:
  - low or zero means the publisher is not spending much time blocked by downstream pressure
  - sustained growth means downstream consumers or buffers are pushing back

This value is also used for the publisher severity highlight:

- **none**: `0`
- **low**: `< 1 ms`
- **medium**: `1 ms` to `< 20 ms`
- **high**: `>= 20 ms`

### Inflight

How many messages are currently buffered or in flight relative to the publisher’s displayed buffer capacity.

- Source fields:
  - `inflight_messages_current`
  - `num_buffers`
  - `inflight_messages_peak_window`
- Displayed as: `current / display_total`
- Interpretation:
  - rising inflight counts can indicate the publisher is outrunning downstream consumption
  - consistently full or near-full inflight counts are a congestion warning

### Messages (window)

How many messages the publisher emitted during the current profiling window.

- Source field: `messages_published_window`
- Displayed as: raw count
- Interpretation:
  - useful as a sanity check against the reported rate and window length

### Publish Delta Avg

Average time between publishes during the current profiling window.

- Source field: `publish_delta_ns_avg_window`
- Displayed as: milliseconds
- Interpretation:
  - lower values mean faster publish cadence
  - higher values mean slower cadence
  - this is often easier to reason about than rate when timing jitter matters

### Host

The host associated with the process that owns the publisher.

- Source field: process `host`
- Displayed as: text

## Subscriber Metrics

Subscriber rows are grouped under a publisher by topic scope.

### Backpressure Avg

Average attributable backpressure per message for that subscriber in the current profiling window.

- Derived from:
  - `attributable_backpressure_ns_window`
  - `messages_received_window`
- Displayed as: milliseconds
- Interpretation:
  - highlights which subscribers are contributing the most downstream pressure on a publisher

### Events (total)

Total number of attributable backpressure events seen for that subscriber.

- Source field: `attributable_backpressure_events_total`
- Displayed as: raw count
- Interpretation:
  - useful for distinguishing one large stall from many repeated smaller stalls

### Msgs

How many messages the subscriber received during the current profiling window.

- Source field: `messages_received_window`
- Displayed as: raw count

### Subscriber Detail Fields

When a subscriber row is expanded, the dashboard also shows:

- endpoint id
- process id
- pid
- host
- average user span
- backpressure sum in the current window

These help identify where the subscriber lives and how much total pressure it contributed.

## Trace Metrics

The trace dock is a time-series view for a single selected publisher endpoint.

### Publish Delta

Per-sample publish interval for the selected publisher.

- Trace metric name: `publish_delta_ns`
- Displayed as: a line/column series in milliseconds
- Interpretation:
  - stable traces imply regular cadence
  - spikes imply jitter, stalls, or bursty scheduling

### Backpressure (all subs)

Aggregate attributable backpressure samples from subscribers associated with the selected publisher topic scope.

- Trace metric name: `attributable_backpressure_ns`
- Displayed as: trace series in milliseconds
- Interpretation:
  - spikes indicate moments where downstream pressure is affecting delivery
  - useful alongside publish delta to determine whether cadence changes correlate with downstream pressure

### Subscribers

Lease-time traces for individual subscribers.

- Trace metric name: `lease_time_ns`
- Displayed as: per-subscriber colored traces
- Interpretation:
  - helps identify whether one subscriber or many are contributing to timing spread
  - useful for spotting outliers in a fanout

## Snapshot vs Trace

These two views answer different questions:

- **Snapshot metrics** answer: "What happened over the most recent profiling window?"
- **Trace metrics** answer: "What is the timing behavior over the last few seconds?"

Use snapshots for quick triage.

Use traces when you need to understand:

- jitter
- burstiness
- intermittent backpressure
- whether a specific subscriber is the outlier

## Reading Common Patterns

### High Rate, Low Backpressure

- publisher is active
- downstream is probably healthy
- look for throughput bottlenecks elsewhere if behavior still looks wrong

### Low Rate, High Publish Delta

- publisher is slow or intentionally sparse
- this may be expected for control streams or periodic heartbeats

### Medium/High Backpressure With Rising Inflight

- downstream is not keeping up
- inspect subscriber rows and trace metrics next

### One Subscriber With High Backpressure Avg

- likely outlier subscriber
- expand that subscriber and inspect its host, process, and detail fields

### Publish Delta Spikes That Line Up With Backpressure Spikes

- strong indication that downstream pressure is affecting publisher cadence

## Caveats

- All interpretations depend on the profiling window and workload shape.
- Sparse publishers can look noisy because a small number of events dominates the window.
- Dense publishers may need shorter windows in the trace dock to remain readable.
- A stream can appear in topology without publisher metrics if profiling data for it is absent.
