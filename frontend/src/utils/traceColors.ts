const LEASE_SUBSCRIBER_COLORS = [
  "#93c5fd",
  "#a78bfa",
  "#f9a8d4",
  "#86efac",
  "#fdba74",
  "#67e8f9",
  "#fca5a5",
  "#c4b5fd",
  "#fde68a",
  "#6ee7b7",
];

export function leaseColorForEndpoint(endpointId: string): string {
  let hash = 0;
  for (let i = 0; i < endpointId.length; i += 1) {
    hash = ((hash * 31) + endpointId.charCodeAt(i)) >>> 0;
  }
  return LEASE_SUBSCRIBER_COLORS[hash % LEASE_SUBSCRIBER_COLORS.length];
}
