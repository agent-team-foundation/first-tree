import { useServerChannelState } from "./use-server-channel.js";

export type MobileExperienceState = {
  enabled: boolean;
  settled: boolean;
};

/**
 * One fail-closed capability gate for every mobile surface and promotion.
 * Older or unreachable servers do not publish the mobile manifest, so they
 * must not advertise an install path that cannot complete.
 */
export function useMobileExperienceState(): MobileExperienceState {
  const { channel, settled: channelSettled } = useServerChannelState();
  if (!channelSettled) {
    return { enabled: false, settled: false };
  }
  return {
    enabled: channel === "dev" || channel === "staging" || channel === "prod",
    settled: true,
  };
}
