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
 *      `first-tree login` on the machine.
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

/**
 * Build the per-page-header subtitle for the Computers page.
 *
 * Inputs:
 *   - `clients`: the rows currently on screen (member: own; admin: org-wide)
 *   - `viewerUserId`: caller's user id — drives whether the single-row
 *     branch uses the possessive headline ("Your computer is ready") or
 *     the neutral phrasing ("1 computer is ready") so admins reading a
 *     teammate's lone row do not get a copy bug.
 *
 * Returns null when there are zero rows. Returns either the per-status
 * headline (single-row, owned by viewer) or a `· `-joined per-pill count
 * with zero-suppression, suffixed by `· N agents bound` to restore the
 * power-user signal that the prior subtitle carried.
 *
 * Pure; exported for testing without rendering React.
 */
export function summarizeComputers(
  clients: HubClient[] | undefined,
  viewerUserId: string | null | undefined,
): string | null {
  if (!clients || clients.length === 0) return null;
  const totalAgents = clients.reduce((n, c) => n + c.agentCount, 0);
  const agentsSuffix = totalAgents > 0 ? ` · ${totalAgents} ${totalAgents === 1 ? "agent" : "agents"} bound` : "";

  if (clients.length === 1) {
    const only = clients[0];
    // biome-ignore lint/style/noNonNullAssertion: length === 1 guards above
    const status = deriveComputerStatus(only!);
    // biome-ignore lint/style/noNonNullAssertion: length === 1 guards above
    if (viewerUserId && only!.userId === viewerUserId) {
      return status.headline + agentsSuffix;
    }
    // Neutral phrasing — admin viewing someone else's lone row.
    const neutral: Record<ComputerStatusPill, string> = {
      ready: "1 computer is ready",
      auth_expired: "1 computer needs to log in again",
      setup_incomplete: "1 computer needs setup",
      offline: "1 computer is offline",
    };
    return neutral[status.pill] + agentsSuffix;
  }

  const counts: Record<ComputerStatusPill, number> = {
    ready: 0,
    auth_expired: 0,
    setup_incomplete: 0,
    offline: 0,
  };
  for (const c of clients) counts[deriveComputerStatus(c).pill] += 1;
  const labels: Record<ComputerStatusPill, string> = {
    ready: "ready",
    auth_expired: "auth expired",
    setup_incomplete: "setup incomplete",
    offline: "offline",
  };
  const segments = (Object.keys(PILL_PRIORITY) as ComputerStatusPill[])
    .sort((a, b) => PILL_PRIORITY[a] - PILL_PRIORITY[b])
    .filter((pill) => counts[pill] > 0)
    .map((pill) => `${counts[pill]} ${labels[pill]}`);
  return segments.join(" · ") + agentsSuffix;
}
