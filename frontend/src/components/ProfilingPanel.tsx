import { Panel } from "./Panel";

export function ProfilingPanel() {
  return (
    <Panel
      title="Profiling"
      subtitle="Snapshot and trace streams for throughput and latency"
    >
      <div className="placeholder">
        <p>Profiling table/chart scaffold</p>
        <ul>
          <li>Per-process rate and latency summaries</li>
          <li>Backpressure counters</li>
          <li>Trace stream status</li>
        </ul>
      </div>
    </Panel>
  );
}
