import type { HubClient, RuntimeAgent } from "../../../api/activity.js";
import { deriveComputerStatus } from "../derive-status.js";

/**
 * Pure view-model layer for the computer cards.
 *
 * Why this exists: the team's test convention is "test the pure
 * view-model, not the rendered DOM" — `presence-chip.test.ts` and
 * `computer-status-pill.test.tsx` both pin a `PILL_VIEW`-style record
 * rather than driving an `@testing-library/react` render. This file
 * mirrors that: each card body has a `viewBody*()` function that
 * returns a render-plan object the body component consumes. Tests
 * assert against the plan; the body component is a thin renderer.
 *
 * The render plans intentionally avoid `ReactNode` and stay as
 * primitives + structured records so they serialize cleanly for snapshot
 * comparisons and stay decoupled from React.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Human-readable "N units ago" for the diagnostic copy on AuthExpired /
 * Offline cards. Distinct from `formatRelative` (lib/utils.ts) — that one
 * is a thin `Intl.RelativeTimeFormat` wrapper that returns "yesterday" /
 * "in 3 seconds" / etc. The card diagnostic wants a stable
 * "8 days" / "2 hours" / "15 minutes" string we can splice into a
 * sentence like "Last seen X ago" or "Offline for X" — locale-fixed,
 * past-only.
 *
 * Returns null when the timestamp is invalid or in the future.
 */
export function formatOfflineDuration(lastSeenIso: string | null | undefined): string | null {
  if (!lastSeenIso) return null;
  const ms = new Date(lastSeenIso).getTime();
  if (Number.isNaN(ms)) return null;
  const elapsed = Date.now() - ms;
  if (elapsed < 0) return null;
  if (elapsed < MS_PER_MINUTE) {
    const seconds = Math.max(1, Math.round(elapsed / 1000));
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  if (elapsed < MS_PER_HOUR) {
    const minutes = Math.round(elapsed / MS_PER_MINUTE);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (elapsed < MS_PER_DAY) {
    const hours = Math.round(elapsed / MS_PER_HOUR);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(elapsed / MS_PER_DAY);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export type AgentLine = {
  agentId: string;
  /** Server-derived runtime state ("idle" / "working" / "blocked" / "error" / null = offline). */
  runtimeState: string | null;
  activeSessions: number | null;
  totalSessions: number | null;
};

export type BoundAgentsSummary = {
  total: number;
  online: number;
  offline: number;
  agents: AgentLine[];
};

/**
 * Reduce a `RuntimeAgent[]` to the data each card body needs to render
 * its agents section. The card-side renderer can resolve agent display
 * names from `agentName(uuid)` — the view-model stays id-only so it can
 * be tested without injecting a name resolver.
 */
export function summarizeBoundAgents(agents: RuntimeAgent[]): BoundAgentsSummary {
  let online = 0;
  let offline = 0;
  const lines: AgentLine[] = agents.map((a) => {
    const isOnline = a.runtimeState !== null && a.runtimeState !== undefined;
    if (isOnline) online += 1;
    else offline += 1;
    return {
      agentId: a.agentId,
      runtimeState: a.runtimeState,
      activeSessions: a.activeSessions,
      totalSessions: a.totalSessions,
    };
  });
  return { total: agents.length, online, offline, agents: lines };
}

/**
 * Diagnostic line shown at the top of the AuthExpired card.
 *
 * Without lastSeenAt: minimal fallback.
 * With lastSeenAt: "This computer hasn't checked in for X. Your access
 * token has expired." — mirrors mockup §"Variant B".
 */
export function authExpiredDiagnostic(client: Pick<HubClient, "lastSeenAt">): string {
  const duration = formatOfflineDuration(client.lastSeenAt);
  if (!duration) return "Your access token has expired. Run the command below on this computer to re-authenticate.";
  return `This computer hasn't checked in for ${duration}. Your access token has expired.`;
}

/**
 * Diagnostic line for Offline card. Distinguishes "moments ago"
 * (probably about to reconnect) from "hours/days ago" (machine actually
 * away).
 */
export function offlineDiagnostic(client: Pick<HubClient, "lastSeenAt">): string {
  const duration = formatOfflineDuration(client.lastSeenAt);
  if (!duration) return "This computer is offline. Make sure the machine is awake and connected.";
  return `Last seen ${duration} ago. Make sure the machine is awake and connected.`;
}

/**
 * Diagnostic line for SetupIncomplete card. Static — the empty
 * capability state doesn't carry a time signal.
 */
export const SETUP_INCOMPLETE_DIAGNOSTIC =
  "This computer is online, but no runtime is ready. Install one of the following on this computer to start running agents:";

/**
 * Per-card hostname fallback. The mockup shows the hostname prominently;
 * pre-PR-A code used `hostname ?? id.slice(0, 8)`. Keep that fallback so
 * a client that registers without a hostname (rare — only happens via a
 * misconfigured SDK build) still has a label.
 */
export function cardHostnameLabel(client: Pick<HubClient, "hostname" | "id">): string {
  return client.hostname ?? client.id.slice(0, 8);
}

export type ComputerCardViewModel = {
  /** Pill name. Drives which body component renders + the aria-label. */
  pill: ReturnType<typeof deriveComputerStatus>["pill"];
  /** Hostname or short-id fallback. */
  label: string;
  /** Per-pill ARIA suffix: "Computer: {label} — {pill text}". */
  ariaLabel: string;
};

const PILL_ARIA: Record<ReturnType<typeof deriveComputerStatus>["pill"], string> = {
  ready: "Ready",
  auth_expired: "Auth expired",
  setup_incomplete: "Setup incomplete",
  offline: "Offline",
};

/**
 * Top-level view-model for `ComputerCard`. Pure + cheap — wraps
 * `deriveComputerStatus` plus the hostname/label/aria fallout. Called
 * once per card render inside `ComputerCard`; the resulting `pill` is
 * threaded down to `CardBody` so we don't re-derive for the body
 * routing.
 */
export function computerCardViewModel(client: HubClient): ComputerCardViewModel {
  const status = deriveComputerStatus(client);
  const label = cardHostnameLabel(client);
  return {
    pill: status.pill,
    label,
    ariaLabel: `Computer: ${label} — ${PILL_ARIA[status.pill]}`,
  };
}
