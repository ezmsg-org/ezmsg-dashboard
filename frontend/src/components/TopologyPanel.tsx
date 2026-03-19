import { Panel } from "./Panel";

export function TopologyPanel() {
  return (
    <Panel
      title="Topology"
      subtitle="Live graph, process ownership, and edge changes"
    >
      <div className="placeholder">
        <p>Graph canvas scaffold</p>
        <ul>
          <li>Node list and filters</li>
          <li>Process ownership badges</li>
          <li>Topology event stream feed</li>
        </ul>
      </div>
    </Panel>
  );
}
