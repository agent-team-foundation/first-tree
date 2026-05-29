/**
 * Mock fixtures for the Team-redesign preview (`/preview/team`, DEV-only).
 *
 * This data drives the visual prototype agreed in
 * `drafts/team-teammates-redesign.md`: two stacked sections — Agent
 * teammates (Public / Private groups) above Human teammates — rendered with
 * the real DESIGN.md tokens/components but NO backend. Fields that depend on
 * not-yet-built backend work (tagline, last-active, custom avatar) are mocked
 * here so reviewers can see the layout before any server change lands.
 *
 * Nothing here is wired to an API; it is intentionally static so the page is
 * deterministic for screenshots and hot-reload review.
 */

/** Token usage for one window — same shape the real Usage column consumes. */
export type PreviewUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  turns: number;
};

export type PreviewAgent = {
  uuid: string;
  /** @handle (mention target). Null only for the rare unnamed agent. */
  name: string | null;
  displayName: string;
  /** One-line "what is this for" — the NEW tagline field (backend-pending). */
  tagline: string;
  visibility: "organization" | "private";
  /** Owning member id (manager_id). */
  managerId: string;
  runtimeProvider: "claude-code" | "codex";
  /**
   * Hostname the agent runs on, or null when it runs on another member's
   * machine and the host can't be resolved — per spec we then show provider
   * only (no host, no fallback).
   */
  clientHost: string | null;
  status: "online" | "offline";
  /** Humanized "last active" for the Status hover (backend-pending source). */
  lastActiveLabel: string;
  /** Custom avatar image — null falls back to initials + identity hue. */
  avatarUrl: string | null;
  usage7d: PreviewUsage | null;
  usage30d: PreviewUsage | null;
};

export type PreviewHuman = {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "member";
  avatarUrl: string | null;
  lastActiveLabel: string;
  /** Resolved delegate identity, or null when none is set. */
  delegate: { uuid: string; name: string | null; displayName: string } | null;
};

/** The signed-in viewer for the preview. Role is overridden by the page toggle. */
export const ME_ID = "u-gandy";

export const MEMBERS: Record<string, { displayName: string; avatarUrl: string | null }> = {
  "u-gandy": { displayName: "Gandy Xiong", avatarUrl: null },
  "u-ava": { displayName: "Ava Chen", avatarUrl: null },
  "u-lin": { displayName: "Lin Zhao", avatarUrl: null },
  "u-marco": { displayName: "Marco Diaz", avatarUrl: null },
};

export const PREVIEW_HUMANS: PreviewHuman[] = [
  {
    id: "u-gandy",
    username: "gandy",
    displayName: "Gandy Xiong",
    role: "member", // displayed role is driven by the page's "Viewing as" toggle
    avatarUrl: null,
    lastActiveLabel: "active now",
    delegate: { uuid: "a-scout", name: "scout", displayName: "Scout" },
  },
  {
    id: "u-ava",
    username: "ava",
    displayName: "Ava Chen",
    role: "admin",
    avatarUrl: null,
    lastActiveLabel: "active 8m ago",
    delegate: { uuid: "a-ava-helper", name: "ava-helper", displayName: "Ava's Helper" },
  },
  {
    id: "u-lin",
    username: "lin",
    displayName: "Lin Zhao",
    role: "member",
    avatarUrl: null,
    lastActiveLabel: "active 2h ago",
    delegate: null,
  },
  {
    id: "u-marco",
    username: "marco",
    displayName: "Marco Diaz",
    role: "member",
    avatarUrl: null,
    lastActiveLabel: "active 3d ago",
    delegate: null,
  },
];

export const PREVIEW_AGENTS: PreviewAgent[] = [
  // ── Public (organization) ──────────────────────────────────────────────
  {
    uuid: "a-kael",
    name: "kael",
    displayName: "Kael",
    tagline: "Flagship reasoning & chat agent for the whole team",
    visibility: "organization",
    managerId: "u-ava",
    runtimeProvider: "claude-code",
    clientHost: "ava-macbook",
    status: "online",
    lastActiveLabel: "active 1m ago",
    avatarUrl: null,
    usage7d: { inputTokens: 980_000, cachedInputTokens: 3_100_000, outputTokens: 420_000, turns: 168 },
    usage30d: { inputTokens: 4_200_000, cachedInputTokens: 12_800_000, outputTokens: 1_900_000, turns: 642 },
  },
  {
    uuid: "a-research",
    name: "research",
    displayName: "Research",
    tagline: "Summarizes papers, threads, and long docs on demand",
    visibility: "organization",
    managerId: "u-gandy", // mine
    runtimeProvider: "claude-code",
    clientHost: "gandy-macbook",
    status: "online",
    lastActiveLabel: "active 4m ago",
    avatarUrl: null,
    usage7d: { inputTokens: 220_000, cachedInputTokens: 540_000, outputTokens: 130_000, turns: 38 },
    usage30d: { inputTokens: 980_000, cachedInputTokens: 2_100_000, outputTokens: 520_000, turns: 142 },
  },
  {
    uuid: "a-marketing",
    name: "marketing-writer",
    displayName: "Marketing Writer",
    tagline: "", // no tagline set — demonstrates the empty state on someone else's agent
    visibility: "organization",
    managerId: "u-lin",
    runtimeProvider: "codex",
    clientHost: "lin-thinkpad",
    status: "offline",
    lastActiveLabel: "active 5h ago",
    avatarUrl: null,
    usage7d: { inputTokens: 120_000, cachedInputTokens: 210_000, outputTokens: 90_000, turns: 11 },
    usage30d: { inputTokens: 380_000, cachedInputTokens: 360_000, outputTokens: 140_000, turns: 38 },
  },
  {
    uuid: "a-support",
    name: "support",
    displayName: "Support",
    tagline: "Triages inbound support and routes to humans",
    visibility: "organization",
    managerId: "u-marco",
    runtimeProvider: "claude-code",
    clientHost: null, // runs on another member's machine — host unresolved
    status: "online",
    lastActiveLabel: "active 12m ago",
    avatarUrl: null,
    usage7d: { inputTokens: 1_400_000, cachedInputTokens: 2_900_000, outputTokens: 600_000, turns: 96 },
    usage30d: { inputTokens: 5_100_000, cachedInputTokens: 9_800_000, outputTokens: 2_200_000, turns: 410 },
  },
  // ── Private ─────────────────────────────────────────────────────────────
  {
    uuid: "a-scout",
    name: "scout",
    displayName: "Scout",
    tagline: "My personal research & errands assistant",
    visibility: "private",
    managerId: "u-gandy", // mine
    runtimeProvider: "claude-code",
    clientHost: "gandy-macbook",
    status: "online",
    lastActiveLabel: "active 2m ago",
    avatarUrl: null,
    usage7d: { inputTokens: 180_000, cachedInputTokens: 320_000, outputTokens: 110_000, turns: 22 },
    usage30d: { inputTokens: 620_000, cachedInputTokens: 1_100_000, outputTokens: 380_000, turns: 64 },
  },
  {
    uuid: "a-sandbox",
    name: "sandbox",
    displayName: "Sandbox",
    tagline: "", // no tagline set — demonstrates the empty state on my own agent (owner CTA)
    visibility: "private",
    managerId: "u-gandy", // mine
    runtimeProvider: "codex",
    clientHost: "gandy-macbook",
    status: "offline",
    lastActiveLabel: "active 6d ago",
    avatarUrl: null,
    usage7d: null,
    usage30d: null,
  },
  {
    uuid: "a-ava-helper",
    name: "ava-helper",
    displayName: "Ava's Helper",
    tagline: "Ava's private drafting helper",
    visibility: "private",
    managerId: "u-ava", // only admins see other members' private agents
    runtimeProvider: "claude-code",
    clientHost: "ava-macbook",
    status: "online",
    lastActiveLabel: "active 20m ago",
    avatarUrl: null,
    usage7d: { inputTokens: 90_000, cachedInputTokens: 140_000, outputTokens: 60_000, turns: 9 },
    usage30d: { inputTokens: 300_000, cachedInputTokens: 220_000, outputTokens: 120_000, turns: 29 },
  },
];

/** Delegate candidates for the signed-in viewer (manager_id == me, not suspended). */
export function myDelegateCandidates(): PreviewAgent[] {
  return PREVIEW_AGENTS.filter((a) => a.managerId === ME_ID);
}
