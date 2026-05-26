import { getChannelConfig } from "@first-tree/shared/channel";
import { CHANNEL } from "../build-info.js";

/**
 * Per-channel runtime identity for this CLI binary. Every place that asks
 * "what's my npm package name", "where's my default home", "which systemd
 * unit do I write" goes through this single value. CI swaps the underlying
 * `CHANNEL` constant in `build-info.ts` to flip the binary into prod /
 * staging shape.
 */
export const channelConfig = getChannelConfig(CHANNEL);
