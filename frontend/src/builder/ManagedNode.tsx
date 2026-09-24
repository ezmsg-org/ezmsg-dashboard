import { useLayoutEffect } from "react";
import { useUpdateNodeInternals, Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { compactMsgType } from "../components/topologyFlowData";
import { unitCardSize, STREAM_NODE_WIDTH, STREAM_NODE_HEIGHT, UNIT_NODE_HEADER_HEIGHT } from "../components/topologyLayout";
import type { Port } from "./document";
export type ManagedFlowNode = Node<{ label: string; componentType?: string; ports: Port[]; editing: boolean; status: string; layout: "lr" | "tb" }, "managed">;
export function managedSize(label: string, type: string, ports: Port[], layout: "lr" | "tb") {
  return unitCardSize(label, type, ports.filter(p => !p.settings && p.direction === "input").length,
    ports.filter(p => !p.settings && p.direction === "output").length, 0, 1, layout,
    value => value.split(/[.:]/).pop() ?? value);
}
export function ManagedNode({ id, data }: NodeProps<ManagedFlowNode>) {
  const update = useUpdateNodeInternals();
  useLayoutEffect(() => { update(id); }, [id, data.layout, data.ports, update]);
  const size = managedSize(data.label, data.componentType ?? "", data.ports, data.layout);
  const position = (port: Port) => {
    const siblings = data.ports.filter(p => !p.settings && p.direction === port.direction);
    const index = siblings.indexOf(port);
    if (data.layout === "lr") return { left: port.direction === "output" ? size.width - STREAM_NODE_WIDTH - 10 : 10,
      top: UNIT_NODE_HEADER_HEIGHT + 6 + index * STREAM_NODE_HEIGHT };
    const gap = 6;
    return { left: (size.width - siblings.length * STREAM_NODE_WIDTH - (siblings.length - 1) * gap) / 2 + index * (STREAM_NODE_WIDTH + gap),
      top: port.direction === "output" ? size.height - STREAM_NODE_HEIGHT - 16 : UNIT_NODE_HEADER_HEIGHT + 2 };
  };
  return <div className={`managed-node ${data.editing ? "is-editing" : ""}`}>
    <div className="topology-unit-label"><span className="topology-title-row"><strong>{data.label}</strong>
      <span className="topology-unit-type" title={data.componentType}>{data.componentType?.split(/[.:]/).pop()}</span></span>
      <span className="mono topology-unit-address">{data.status}</span></div>
    {data.ports.filter(p => !p.settings).map(p => <div className={`managed-port is-${p.direction}`} key={p.name} title={p.message_type} style={position(p)}>
      <span className={`managed-topic mono topology-stream-label is-${p.direction}`} >
      {p.direction === "input" && <Handle type="target" id={p.name} position={data.layout === "lr" ? Position.Left : Position.Top} isConnectable={data.editing} />}
      <span className="topology-stream-name">{p.name}</span>
      <span className="topology-stream-type">[{compactMsgType(p.message_type)}]</span>
      {p.direction === "output" && <Handle type="source" id={p.name} position={data.layout === "lr" ? Position.Right : Position.Bottom} isConnectable={data.editing} />}
      </span>
    </div>)}
  </div>;
}
export function ExternalNode({ id, data }: NodeProps<Node<{ label: React.ReactNode }, "external">>) {
  const update = useUpdateNodeInternals();
  useLayoutEffect(() => { update(id); }, [id, update]);
  return <div className="external-node">{data.label}<Handle type="source" id="OUTPUT" position={Position.Right} isConnectable={false} /></div>;
}
export const builderNodeTypes = { managed: ManagedNode, external: ExternalNode };
