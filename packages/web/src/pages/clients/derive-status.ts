import type { HubClient } from "../../api/activity.js";

export type ComputerStatusPill = "ready" | "auth_expired" | "setup_incomplete" | "offline";

export type ComputerStatus = {
  pill: ComputerStatusPill;
  /** Headline copy for the top-of-page sentence. */
  headline: string;
};

/**
 * Pure 4-state pill derivation for a computer row.
 *
 * Inputs come entirely from existing server fields — `status`,
 * `authState`, and `capabilities` — so the pill costs zero new server
 * columns and zero thresholds.
 *
 * Ordering of the checks below is by user-actionable severity, most
 * actionable first:
 *
 *   1. `auth_expired` — credentials are dead, the user must rerun
 *      the channel-aware login command on the machine.
 *   2. `offline`      — credentials are alive but the machine is not.
 *   3. `ready`        — connected and at least one runtime is `ok`.
 *   4. `setup_incomplete` — connected but no runtime is `ok` yet.
 *
 * Note on the relationship between `auth_expired` and `offline`: the
 * server contract in `services/client.ts:deriveAuthState` only returns
 * `expired` when `status=disconnected` AND offline duration exceeds
 * the refresh-token TTL. So `expired ⊂ disconnected` today and the
 * step-2 `status !== "connected"` branch is unreachable when step 1
 * matched. Both are kept as defensive ordering in case the server
 * grows admin-driven revocation (auth could go expired while the
 * row is still `connected`).
 */
export function deriveComputerStatus(client: HubClient): ComputerStatus {
  if (client.authState === "expired") {
    return { pill: "auth_expired", headline: "Your computer needs to log in again" };
  }
  if (client.status !== "connected") {
    return { pill: "offline", headline: "Your computer is offline" };
  }
  const caps = client.capabilities ?? {};
  const anyOk = Object.values(caps).some((entry) => entry?.state === "ok");
  if (anyOk) {
    return { pill: "ready", headline: "Your computer is ready" };
  }
  return { pill: "setup_incomplete", headline: "Finish setting up your computer" };
}

/**
 * Priority order — smaller is "more urgent / sorts earlier". The list
 * page sorts rows by this so problem rows bubble to the top without the
 * viewer needing to scan a long table.
 */
export const PILL_PRIORITY: Record<ComputerStatusPill, number> = {
  auth_expired: 0,
  setup_incomplete: 1,
  offline: 2,
  ready: 3,
};

/**
 * Sort comparator: pill priority ascending (problems first), then
 * `lastSeenAt` descending (most recently active wins the tie). Stable
 * w.r.t. the underlying `Array.prototype.sort`.
 */
export function compareByPillPriority(a: HubClient, b: HubClient): number {
  const pa = PILL_PRIORITY[deriveComputerStatus(a).pill];
  const pb = PILL_PRIORITY[deriveComputerStatus(b).pill];
  if (pa !== pb) return pa - pb;
  if (a.lastSeenAt > b.lastSeenAt) return -1;
  if (a.lastSeenAt < b.lastSeenAt) return 1;
  return 0;
}
