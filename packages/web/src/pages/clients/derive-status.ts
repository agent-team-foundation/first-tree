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

const HOSTNAME_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function normalizedHostname(client: HubClient): string | null {
  const hostname = client.hostname?.trim();
  return hostname ? hostname : null;
}

/**
 * Sort comparator: pill priority ascending (problems first), then
 * stable computer identity: hostname natural-sort ascending (unnamed
 * computers last), then client id.
 */
export function compareByPillPriority(a: HubClient, b: HubClient): number {
  const pa = PILL_PRIORITY[deriveComputerStatus(a).pill];
  const pb = PILL_PRIORITY[deriveComputerStatus(b).pill];
  if (pa !== pb) return pa - pb;

  const ah = normalizedHostname(a);
  const bh = normalizedHostname(b);
  if (ah && !bh) return -1;
  if (!ah && bh) return 1;
  if (ah && bh) {
    const byHostname = HOSTNAME_COLLATOR.compare(ah, bh);
    if (byHostname !== 0) return byHostname;
    const byRawHostname = ah.localeCompare(bh);
    if (byRawHostname !== 0) return byRawHostname;
  }

  return a.id.localeCompare(b.id);
}

/**
 * Ordered numeric components of a version string — every integer run, in
 * order: "0.5.3-staging.49.1" → [0, 5, 3, 49, 1]. Lets us compare both plain
 * semver ("0.6.0") and channel builds without a semver dependency. Returns
 * null when there's no parseable number (so callers can fail safe).
 */
function versionParts(version: string | null | undefined): number[] | null {
  if (!version) return null;
  const runs = version.match(/\d+/g);
  return runs ? runs.map((n) => Number.parseInt(n, 10)) : null;
}

/**
 * Is `current` strictly behind `target`? Conservative on unparseable input:
 * when we can't compare, we return `true` so a recorded failure is surfaced
 * rather than silently hidden.
 */
function isVersionBehind(current: string | null | undefined, target: string): boolean {
  const c = versionParts(current);
  const t = versionParts(target);
  if (!c || !t) return true;
  const len = Math.max(c.length, t.length);
  for (let i = 0; i < len; i++) {
    const cv = c[i] ?? 0;
    const tv = t[i] ?? 0;
    if (cv !== tv) return cv < tv;
  }
  return false;
}

/**
 * A `failed` / `blocked` self-update leaves the machine stuck on an old
 * version. The server exposes it (`lastUpdateAttempt`) precisely so the admin
 * dashboard can flag it — it needs attention even while the client is
 * otherwise connected with an OK runtime (so the 4-state pill reads `Ready`).
 *
 * The record is the *last* attempt, not a live "still stuck" flag, and the
 * manual recovery paths (`first-tree upgrade` / manual reinstall) don't write
 * an `ok` attempt or clear it. So a machine that has since reached the target
 * carries a stale failure — we treat it as a problem only while the reported
 * `sdkVersion` is still behind the attempt's `target`.
 */
export function hasUpdateProblem(client: HubClient): boolean {
  const attempt = client.lastUpdateAttempt;
  if (attempt?.result !== "failed" && attempt?.result !== "blocked") return false;
  return isVersionBehind(client.sdkVersion, attempt.target);
}

/**
 * Whether a computer belongs in the Team-list "Needs attention" group: any
 * non-`ready` runtime pill (auth-expired / setup-incomplete / offline) OR a
 * failed/blocked self-update on an otherwise-ready machine. This is the audit
 * view's health predicate — broader than the pill alone so a stuck update is
 * never hidden under `Ready`.
 */
export function teamNeedsAttention(client: HubClient): boolean {
  return deriveComputerStatus(client).pill !== "ready" || hasUpdateProblem(client);
}

/**
 * Split a team-computer list into the "Needs attention" and "Ready" groups,
 * each pill-priority sorted (problems first; a Ready-but-update-stuck machine
 * sorts after the true pill problems since its pill is still `ready`).
 */
export function partitionTeamComputers(clients: HubClient[]): { attention: HubClient[]; ready: HubClient[] } {
  const attention: HubClient[] = [];
  const ready: HubClient[] = [];
  for (const client of [...clients].sort(compareByPillPriority)) {
    (teamNeedsAttention(client) ? attention : ready).push(client);
  }
  return { attention, ready };
}
