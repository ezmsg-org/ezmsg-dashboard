import { describe, expect, it } from "vitest";

import {
  COLLECTION_OPEN_BUTTON_MIN_WIDTH,
  STREAM_NODE_WIDTH,
  STREAM_ROW_GAP,
  STREAM_ROW_HORIZONTAL_PADDING,
  TASK_NODE_WIDTH,
  TASK_ROW_GAP,
  TASK_ROW_HORIZONTAL_PADDING,
  UNIT_LR_MIN_WIDTH,
  estimateCollectionHeaderMinWidth,
  estimateUnitHeaderMinWidth,
  requiredRowWidth,
} from "./topologyLayout";

function shortType(value: string): string {
  const parts = value.split(".");
  return parts[parts.length - 1] ?? value;
}

describe("topology layout helpers", () => {
  it("keeps row width calculations aligned with shared constants", () => {
    expect(
      requiredRowWidth(
        4,
        STREAM_NODE_WIDTH,
        STREAM_ROW_GAP,
        STREAM_ROW_HORIZONTAL_PADDING
      )
    ).toBe(4 * STREAM_NODE_WIDTH + 3 * STREAM_ROW_GAP + STREAM_ROW_HORIZONTAL_PADDING);

    expect(
      requiredRowWidth(
        3,
        TASK_NODE_WIDTH,
        TASK_ROW_GAP,
        TASK_ROW_HORIZONTAL_PADDING
      )
    ).toBe(3 * TASK_NODE_WIDTH + 2 * TASK_ROW_GAP + TASK_ROW_HORIZONTAL_PADDING);
  });

  it("reserves space for collection action buttons", () => {
    const width = estimateCollectionHeaderMinWidth(
      "SYSTEM",
      "fixture.deep.namespace.ExtremelyLongCollectionComponentType",
      shortType
    );
    expect(width).toBeGreaterThan(COLLECTION_OPEN_BUTTON_MIN_WIDTH);
    expect(width).toBeGreaterThan(
      estimateUnitHeaderMinWidth("SYSTEM", "fixture.Unit", shortType) - 20
    );
  });

  it("keeps lr unit width tied to one lane per side instead of stream count", () => {
    expect(UNIT_LR_MIN_WIDTH).toBe(2 * STREAM_NODE_WIDTH + TASK_NODE_WIDTH + 60);
  });
});
