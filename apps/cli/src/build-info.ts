// Release channel of this binary. Source-tree value is "dev". CI rewrites
// this file to "staging" or "prod" before `pnpm build` so the published
// tarball has the value baked in as a literal — runtime channel detection
// is intentionally zero-logic. Keep this file minimal and dependency-free:
// it is the load-bearing input to channel resolution that runs before
// anything else in the CLI.
import type { ChannelName } from "@first-tree/shared/channel";

export const CHANNEL: ChannelName = "dev";
