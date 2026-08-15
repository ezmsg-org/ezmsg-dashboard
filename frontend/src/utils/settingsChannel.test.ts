import { describe, expect, it } from "vitest";

import { isSettingsChannelTopic } from "./settingsChannel";

describe("settings channel topics", () => {
  it("recognizes a unit's dynamic settings channel", () => {
    expect(isSettingsChannelTopic("SYSTEM/PING/INPUT_SETTINGS")).toBe(true);
    expect(
      isSettingsChannelTopic(
        "INTRACRANIAL_FEATURES/INTENT_FEATURES/HUB1/SDA/INPUT_SETTINGS"
      )
    ).toBe(true);
  });

  it("leaves data topics alone", () => {
    expect(isSettingsChannelTopic("SYSTEM/PING_TOPIC")).toBe(false);
    expect(isSettingsChannelTopic("SYSTEM/PING/OUTPUT_SIGNAL")).toBe(false);
    // A topic that merely mentions settings is not the settings channel.
    expect(isSettingsChannelTopic("SYSTEM/INPUT_SETTINGS_MONITOR")).toBe(false);
    expect(isSettingsChannelTopic("SYSTEM/PING/INPUT_SETTINGS_2")).toBe(false);
  });
});
