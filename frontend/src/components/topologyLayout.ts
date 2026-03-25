export const UNIT_WIDTH = 320;
export const MIN_UNIT_HEIGHT = 120;
export const RANK_Y_GAP = 88;
export const RANK_X_GAP = 120;
export const OWNER_X_GAP = 72;
export const OWNER_Y_GAP = 58;
export const STREAM_NODE_WIDTH = 100;
export const STREAM_NODE_HEIGHT = 30;
export const TASK_NODE_WIDTH = 96;
export const TASK_NODE_HEIGHT = 22;
export const STREAM_ROW_GAP = 6;
export const TASK_ROW_GAP = 10;
export const STREAM_ROW_HORIZONTAL_PADDING = 22;
export const TASK_ROW_HORIZONTAL_PADDING = 20;
export const ORPHAN_NODE_WIDTH = 240;
export const COLLECTION_NODE_WIDTH = 300;
export const COLLECTION_NODE_HEIGHT = 168;
export const COLLECTION_NODE_HEADER_HEIGHT = 74;
export const COLLECTION_SCOPE_BOTTOM_PADDING = 58;
export const UNIT_NODE_HEADER_HEIGHT = 48;
export const COLLECTION_OPEN_BUTTON_MIN_WIDTH = 87;
export const COLLECTION_HEADER_INNER_PADDING = 26;
export const UNIT_HEADER_INNER_PADDING = 30;
export const FOCUS_VIEW_PADDING = 0.36;
export const FOCUS_VIEW_DURATION_MS = 240;
export const FOCUS_VIEW_MIN_ZOOM = 0.35;
export const FOCUS_VIEW_MAX_ZOOM = 1.8;

export function estimateCollectionHeaderMinWidth(
  collectionName: string,
  componentType: string,
  shortType: (value: string) => string
): number {
  const nameWidth = Math.min(176, Math.max(104, collectionName.length * 7.4));
  const typeWidth = Math.min(
    112,
    Math.max(66, shortType(componentType).length * 6.1 + 14)
  );
  return (
    nameWidth
    + typeWidth
    + COLLECTION_OPEN_BUTTON_MIN_WIDTH
    + COLLECTION_HEADER_INNER_PADDING
  );
}

export function estimateUnitHeaderMinWidth(
  unitName: string,
  componentType: string,
  shortType: (value: string) => string
): number {
  const nameWidth = Math.min(220, Math.max(96, unitName.length * 8));
  const typeWidth = Math.min(
    122,
    Math.max(66, shortType(componentType).length * 6.1 + 14)
  );
  return nameWidth + typeWidth + UNIT_HEADER_INNER_PADDING;
}

export function requiredRowWidth(
  count: number,
  itemWidth: number,
  minGap: number,
  horizontalPadding: number
): number {
  if (count <= 0) {
    return horizontalPadding;
  }
  return count * itemWidth + Math.max(0, count - 1) * minGap + horizontalPadding;
}
