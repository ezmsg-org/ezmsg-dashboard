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
  "#fda4af",
  "#5eead4",
  "#ddd6fe",
  "#bef264",
  "#fbcfe8",
  "#bae6fd",
];

function hashText(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash * 31) + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function fallbackColorForIndex(index: number): string {
  const hue = (index * 137.508) % 360;
  return `hsl(${hue.toFixed(1)} 75% 68%)`;
}

export function buildLeaseColorMap(endpointIds: string[]): Record<string, string> {
  const sortedUnique = [...new Set(endpointIds)].sort();
  const out: Record<string, string> = {};
  for (let i = 0; i < sortedUnique.length; i += 1) {
    const endpointId = sortedUnique[i];
    out[endpointId] =
      i < LEASE_SUBSCRIBER_COLORS.length
        ? LEASE_SUBSCRIBER_COLORS[i]
        : fallbackColorForIndex(i);
  }
  return out;
}

export function leaseColorForEndpoint(
  endpointId: string,
  colorMap?: Record<string, string>
): string {
  if (colorMap && typeof colorMap[endpointId] === "string") {
    return colorMap[endpointId];
  }
  const hash = hashText(endpointId);
  return LEASE_SUBSCRIBER_COLORS[hash % LEASE_SUBSCRIBER_COLORS.length];
}
