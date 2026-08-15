/**
 * Units that expose dynamic settings get a publisher on `<unit>/INPUT_SETTINGS`,
 * created the first time a setting is patched. It is a control-plane endpoint:
 * it carries settings updates, publishes nothing the rest of the time, and sits
 * in the publishers list at 0 Hz looking exactly like a data publisher --
 * including offering a profiling trace that can never produce a sample.
 *
 * They are hidden by default and can be shown again from global settings.
 */

const SETTINGS_CHANNEL_SUFFIX = "/INPUT_SETTINGS";

export function isSettingsChannelTopic(topic: string): boolean {
  return topic.endsWith(SETTINGS_CHANNEL_SUFFIX);
}
