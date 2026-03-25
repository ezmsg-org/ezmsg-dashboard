export type ParsedStreamAddress = {
  topic: string | null;
  endpointId: string | null;
};

export function streamAddressWithoutEndpoint(address: string): string {
  return address.split(":")[0] ?? address;
}

export function parseTopicAndEndpoint(streamAddress: string): {
  topic: string;
  endpointToken: string;
} {
  const [topic, ...endpointParts] = streamAddress.split(":");
  return {
    topic: topic ?? "",
    endpointToken: endpointParts.join(":"),
  };
}

export function endpointIdFromStreamAddress(streamAddress: string): string | null {
  const { endpointToken } = parseTopicAndEndpoint(streamAddress);
  return endpointToken.length > 0 ? endpointToken : null;
}

export function parseStreamAddress(streamAddress: string): ParsedStreamAddress {
  const { topic, endpointToken } = parseTopicAndEndpoint(streamAddress);
  return {
    topic: topic.length > 0 ? topic : null,
    endpointId: endpointToken.length > 0 ? endpointToken : null,
  };
}
