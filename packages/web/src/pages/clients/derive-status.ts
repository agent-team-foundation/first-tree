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
 * A version parsed into a same-channel comparable form. Only the two shapes
 * First Tree's durable channel contract accepts are supported (mirrors
 * `inferChannelFromVersion` in `@first-tree/shared`'s channel module):
 *   - prod:    `X.Y.Z`             → { channel: "prod",    parts: [X, Y, Z] }
 *   - staging: `X.Y.Z-staging.N.M` → { channel: "staging", parts: [X, Y, Z, N, M] }
 * Anything else — dev, alpha/beta/rc, partial (`1.4`), or otherwise malformed
 * — is unsupported and returns null so callers fail closed.
 */
type ParsedVersion = { channel: "prod" | "staging"; parts: number[] };

function parseSupportedVersion(version: string | null | undefined): ParsedVersion | null {
  if (!version) return null;
  const staging = /^(\d+)\.(\d+)\.(\d+)-staging\.(\d+)\.(\d+)$/.exec(version);
  if (staging) return { channel: "staging", parts: staging.slice(1).map((n) => Number.parseInt(n, 10)) };
  const prod = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (prod) return { channel: "prod", parts: prod.slice(1).map((n) => Number.parseInt(n, 10)) };
  return null;
}

function comparePartsAscending(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Has a recorded failed/blocked update since been resolved? Only a **valid,
 * same-channel** current version at or beyond a **valid** target clears the
 * historical failure. Malformed, unknown/mismatched-channel, or missing
 * versions fail closed (return false) so a genuine failure is never hidden by
 * an unparseable version — e.g. a staging build never counts as having reached
 * a stable prod target (prerelease < stable), and `garbage999` never outranks
 * `1.4.0`.
 */
function updateResolved(current: string | null | undefined, target: string): boolean {
  const c = parseSupportedVersion(current);
  const t = parseSupportedVersion(target);
  if (!c || !t || c.channel !== t.channel) return false;
  return comparePartsAscending(c.parts, t.parts) >= 0;
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
 * carries a stale failure — treat it as a problem unless we can prove, within
 * one accepted channel, that the reported version reached/passed the target.
 */
export function hasUpdateProblem(client: HubClient): boolean {
  const attempt = client.lastUpdateAttempt;
  if (attempt?.result !== "failed" && attempt?.result !== "blocked") return false;
  return !updateResolved(client.sdkVersion, attempt.target);
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
