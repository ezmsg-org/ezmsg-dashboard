# Metrics Reference

This document explains the metrics currently surfaced in the dashboard UI.

The dashboard now splits profiling into two layers:

- **snapshot metrics**: cheap always-on counters and current state
- **trace metrics**: timing-oriented samples collected only while trace is active

Units in the UI are generally shown in:

- **Hz** for rates
- **ms** for timing values that originate as nanoseconds

## Publisher Snapshot Metrics

### Rate

How fast a publisher is currently publishing during the latest snapshot window.

- Source field: `publish_rate_hz_window`
- Displayed as: `Hz`

### Messages (window)

How many messages the publisher emitted during the latest snapshot interval.

- Source field: `messages_published_window`
- Displayed as: raw count

### Inflight

How many messages are currently buffered or in flight for the publisher.

- Source fields:
  - `inflight_messages_current`
  - `num_buffers`
- Displayed as: `current / num_buffers` when buffer capacity is known

### Host

The host associated with the process that owns the publisher.

- Source field: process `host`
- Displayed as: text

## Subscriber Snapshot Metrics

Subscriber rows are grouped under a publisher by topic scope. The scope follows
the publisher's topic through every forward in the graph, so a subscriber
several collection boundaries away still appears under the publisher that feeds
it.

### Msgs

How many messages the subscriber received during the latest snapshot interval.

- Source field: `messages_received_window`
- Displayed as: raw count

### Channel

The most recent transport or channel kind observed for that subscriber.

- Source field: `channel_kind_last`
- Displayed as: text

### Process And Host

Subscriber detail rows show where the subscriber lives.

- Source fields:
  - subscriber process id
  - subscriber pid
  - subscriber host

## Trace Metrics

The trace dock is a time-series view for a single selected publisher endpoint.

### Publish Delta

Per-sample publish interval for the selected publisher.

- Trace metric name: `publish_delta_ns`
- Displayed as: time-series line in milliseconds

### Lease Time

Per-subscriber timing for message receive and lease handling while trace is active.

- Trace metric name: `lease_time_ns`
- Displayed as: per-subscriber colored traces when `Lease Time` is selected

### User Span

Per-subscriber user-code span timing while trace is active.

- Trace metric name: `user_span_ns`
- Displayed as: per-subscriber colored traces when `User Span` is selected

## Snapshot vs Trace

These two views answer different questions:

- **Snapshot metrics** answer: "What happened over the most recent profiling window?"
- **Trace metrics** answer: "What is the timing behavior over the last few seconds while trace is active?"

Use snapshots for quick triage and topology-aware inspection.

Use traces when you need to understand:

- publish jitter
- subscriber lease timing
- subscriber user-code timing
- whether one subscriber is an outlier

## Reading Common Patterns

### High Rate, Low Inflight

- publisher is active
- downstream is probably keeping up

### Rising Inflight With Healthy Rate

- publisher throughput is fine, but buffering pressure may be building
- start trace if timing detail is needed

### Lease Time Outlier

- one subscriber is slower to receive or lease messages
- select that subscriber and compare its lease series against peers

### User Span Outlier

- one subscriber is spending more time in user code
- compare user span against lease time to separate transport cost from handler cost

## Caveats

- Snapshot timing fields are intentionally gone; timing diagnostics are trace-only.
- Sparse publishers can look noisy because a small number of events dominates the window.
- Dense publishers may need shorter windows in the trace dock to remain readable.
- A stream can appear in topology without publisher metrics if profiling data for it is absent.
