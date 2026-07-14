import type { CapabilityEntry } from "@first-tree/shared";
import type { HubClient, RuntimeAgent } from "../../api/activity.js";

/**
 * DEV-only fixtures for the `?demo=<key>` query-param mode of
 * `ClientsPage`. Lets a reviewer flip the live `/settings/computers`
 * page through every pill × sub-variant without seeding the local DB
 * or running multiple daemons.
 *
 * The page reads `?demo=<key>` from the URL when `import.meta.env.DEV`
 * is true; if a scenario matches it overrides the react-query results
 * and renders the same JSX with these fixtures. Production builds
 * never check this param — but the module is tree-shake-friendly
 * anyway (pure data + builders).
 *
 * Each scenario carries a `whatToCheck` checklist surfaced by the
 * floating `<DemoNavigator>` overlay so the reviewer knows what's
 * distinctive about the state without reading the source.
 */

const NOW = Date.now();

function isoMinutesAgo(min: number): string {
  return new Date(NOW - min * 60_000).toISOString();
}

function isoDaysAgo(days: number): string {
  return new Date(NOW - days * 24 * 60 * 60_000).toISOString();
}

function cap(state: CapabilityEntry["state"], overrides: Partial<CapabilityEntry> = {}): CapabilityEntry {
  return {
    state,
    // Install-only detection: `available` mirrors `state === "ok"` (the binary
    // is installed/resolvable), independent of whether it's logged in.
    available: state === "ok",
    detectedAt: overrides.detectedAt ?? isoMinutesAgo(1),
    sdkVersion: overrides.sdkVersion,
    runtimeSource: overrides.runtimeSource,
    runtimePath: overrides.runtimePath,
    error: overrides.error,
  };
}

function client(overrides: Partial<HubClient>): HubClient {
  return {
    id: overrides.id ?? "fixture",
    userId: overrides.userId ?? "self-uuid",
    status: overrides.status ?? "connected",
    authState: overrides.authState ?? "ok",
    binName: overrides.binName ?? "first-tree-dev",
    sdkVersion: overrides.sdkVersion ?? "0.5.3-staging.49.1",
    hostname: overrides.hostname ?? "MacBook-Pro.local",
    os: overrides.os ?? "darwin",
    agentCount: overrides.agentCount ?? 0,
    connectedAt: overrides.connectedAt ?? isoMinutesAgo(30),
    lastSeenAt: overrides.lastSeenAt ?? isoMinutesAgo(0.2),
    capabilities: overrides.capabilities ?? {},
  };
}

function agent(overrides: Partial<RuntimeAgent>): RuntimeAgent {
  // Default runtimeType picks claude-code for "*-dev" agents and codex
  // for "*-asst" agents — gives the demo gallery visual variety when
  // multiple agents are bound to the same fixture. Pin explicitly via
  // `overrides.runtimeType` when a scenario needs a specific provider.
  const id = overrides.agentId ?? "agent-uuid";
  const defaultRuntime = id.endsWith("asst") ? "codex" : "claude-code";
  return {
    agentId: id,
    clientId: overrides.clientId ?? "fixture",
    runtimeType: overrides.runtimeType !== undefined ? overrides.runtimeType : defaultRuntime,
    runtimeState: overrides.runtimeState ?? "idle",
    activeSessions: overrides.activeSessions ?? 0,
    totalSessions: overrides.totalSessions ?? 0,
    runtimeUpdatedAt: overrides.runtimeUpdatedAt ?? isoMinutesAgo(1),
    type: overrides.type ?? null,
    managedByMe: overrides.managedByMe ?? true,
  };
}

export const DEMO_SELF_USER_ID = "self-uuid";

/**
 * The set of clients + agents a particular `?demo=<key>` selects.
 * Most scenarios use a single own-machine; "stack" and "admin-grouped"
 * use multiple to exercise list-level UX.
 */
export type DemoScenario = {
  key: string;
  group: "Ready" | "Auth expired" | "Setup incomplete" | "Offline" | "Cross-cutting";
  title: string;
  summary: string;
  whatToCheck: string[];
  /** All clients in this scenario — first one is the "viewer's own" for non-admin paths. */
  clients: HubClient[];
  agents: RuntimeAgent[];
};

/**
 * Build the entire fixture set inside a function so prod bundles can
 * tree-shake it. The module-level `DEMO_SCENARIOS` const below is gated
 * on `import.meta.env.DEV`: in production builds, Vite folds it to
 * `false`, the ternary picks the empty branch, and `buildDemoData` is
 * never referenced → Rollup DCE drops the entire function body plus
 * the `cap` / `client` / `agent` helpers and per-fixture consts inside.
 *
 * Without this gating the SCENARIOS array (and all its inline
 * fixtures) showed up in the prod bundle even though the demo
 * navigator was tree-shaken at the render layer — that's what
 * yuezengwu flagged in PR-D2 review nit #1.
 */
function buildDemoData(): { scenarios: DemoScenario[]; agentNames: Record<string, string> } {
  const READY_BOTH = client({
    id: "demo-ready-both",
    hostname: "GandydeMacBook-Pro.local",
    capabilities: {
      "claude-code": cap("ok", { sdkVersion: "0.2.141" }),
      codex: cap("ok", { sdkVersion: "0.125.0" }),
    },
  });

  const READY_CC_ONLY = client({
    id: "demo-ready-cc-only",
    hostname: "Linux-box.lan",
    capabilities: {
      "claude-code": cap("ok", { sdkVersion: "0.2.141" }),
    },
  });

  const READY_MIXED = client({
    id: "demo-ready-mixed",
    hostname: "MacBook-Pro.local",
    capabilities: {
      // Both installed — install-only detection no longer distinguishes
      // logged-in vs logged-out; "ok" just means the binary is present.
      "claude-code": cap("ok", { sdkVersion: "0.2.141" }),
      codex: cap("ok", { sdkVersion: "0.125.0" }),
    },
  });

  const AUTH_EXPIRED = client({
    id: "demo-auth-expired",
    hostname: "Mac-mini.attic",
    status: "disconnected",
    authState: "expired",
    lastSeenAt: isoDaysAgo(8),
    sdkVersion: "0.5.1",
    capabilities: {
      "claude-code": cap("ok", { sdkVersion: "0.2.130" }),
    },
  });

  const SETUP_EMPTY = client({
    id: "demo-setup-empty",
    hostname: "fresh-linux-box.local",
    os: "linux",
  });

  const SETUP_MIXED = client({
    id: "demo-setup-mixed",
    hostname: "MacBook-Pro.local",
    capabilities: {
      // Installed (Codex absent from the map → "missing"). With install-only
      // detection "installed" is just `ok`; the card no longer renders a
      // logged-out state here.
      "claude-code": cap("ok", { sdkVersion: "0.2.141" }),
    },
  });

  const SETUP_ERROR = client({
    id: "demo-setup-error",
    hostname: "MacBook-Pro.local",
    capabilities: {
      codex: cap("error", { error: "ENOENT: spawn /usr/local/bin/codex" }),
    },
  });

  const OFFLINE_RECENT = client({
    id: "demo-offline-recent",
    hostname: "MacBook-Pro.local",
    status: "disconnected",
    lastSeenAt: isoMinutesAgo(120),
    capabilities: {
      "claude-code": cap("ok", { sdkVersion: "0.2.141" }),
    },
  });

  const OFFLINE_STALE = client({
    id: "demo-offline-stale",
    hostname: "old-laptop.fritz.box",
    status: "disconnected",
    lastSeenAt: isoDaysAgo(4),
    capabilities: {
      "claude-code": cap("ok", { sdkVersion: "0.2.130" }),
    },
  });

  const TEAM_MACHINE = client({
    id: "demo-team-machine",
    userId: "other-user",
    hostname: "alice-MBP.lan",
    agentCount: 1,
    capabilities: {
      "claude-code": cap("ok", { sdkVersion: "0.2.141" }),
    },
  });

  const TEAM_READY_LINUX = client({
    id: "demo-team-ready-linux",
    userId: "dave-user",
    hostname: "BAI-MATEBOOK",
    os: "linux",
    agentCount: 5,
    capabilities: {
      "claude-code": cap("ok", { sdkVersion: "0.2.141" }),
    },
  });

  // Long hostname exercises single-line ellipsis truncation on the team row.
  const TEAM_OFFLINE = client({
    id: "demo-team-offline",
    userId: "bob-user",
    hostname: "ci-runner-7f3a91b2c4d5e6f8a0b1.internal",
    os: "linux",
    status: "disconnected",
    lastSeenAt: isoMinutesAgo(3 * 24 * 60),
    sdkVersion: "0.5.1-staging.12.1",
    agentCount: 1,
    capabilities: {
      "claude-code": cap("ok", { sdkVersion: "0.2.120" }),
    },
  });

  const TEAM_AUTH_EXPIRED = client({
    id: "demo-team-auth-expired",
    userId: "carol-user",
    hostname: "carol-mac-mini.local",
    status: "disconnected",
    authState: "expired",
    lastSeenAt: isoMinutesAgo(6 * 60),
    sdkVersion: "0.5.2-staging.31.4",
    agentCount: 1,
    capabilities: {
      "claude-code": cap("ok", { sdkVersion: "0.2.130" }),
    },
  });

  const agentNames: Record<string, string> = {
    "a-dev": "gandy-developer",
    "a-asst": "gandy-assistant",
    "a-rev": "code-reviewer",
    "a-other": "alice-bot",
  };

  const scenarios: DemoScenario[] = [
    {
      key: "ready-both",
      group: "Ready",
      title: "Ready · both runtimes ok · 2 agents",
      summary:
        "Happy path. Pill is Ready when status=connected, authState=ok, AND ≥1 capability=ok. Both runtimes ok is the most common shape.",
      whatToCheck: [
        "Green pill 'Ready' in the top-right",
        "Hostname is the visual focus (font-semibold); owner label 'gandy · you' below (no nested parens)",
        "Heartbeat / First Tree / OS as 2-col `<dl>` field grid",
        "Runtimes block: ✓ Claude Code + ✓ Codex, lowercase label 'Runtimes'",
        "Agent rows: name + presence chip only, no '3 / 7 sessions' counter",
        "No background tint / shadow / radius — flat with hairlines",
      ],
      clients: [READY_BOTH],
      agents: [
        agent({ agentId: "a-dev", clientId: READY_BOTH.id, runtimeState: "idle" }),
        agent({ agentId: "a-asst", clientId: READY_BOTH.id, runtimeState: "idle" }),
      ],
    },
    {
      key: "ready-cc-only",
      group: "Ready",
      title: "Ready · only Claude Code · 0 agents",
      summary: "Ready with one runtime ok + one missing. Bound-agents block hides entirely when total=0.",
      whatToCheck: [
        "Pill still Ready (one ok is enough)",
        "Runtimes: ✓ Claude Code + ✗ Codex 'not installed' inline",
        "Agents block NOT rendered — only 2 groups (meta + runtimes)",
      ],
      clients: [READY_CC_ONLY],
      agents: [],
    },
    {
      key: "ready-mixed",
      group: "Ready",
      title: "Ready · both runtimes installed",
      summary:
        "Both runtimes installed (install-only detection). Card is Ready; each row shows a green ✓ installed line.",
      whatToCheck: [
        "Pill stays Ready (≥1 runtime installed)",
        "Codex line shows ✓ + 'Codex installed v0.125.0'",
        "Green ✓ on both rows — no login/Connect affordance on the card",
      ],
      clients: [READY_MIXED],
      agents: [agent({ agentId: "a-dev", clientId: READY_MIXED.id, runtimeState: "running" })],
    },
    {
      key: "auth-expired",
      group: "Auth expired",
      title: "Auth expired · 8 days · 3 agents",
      summary:
        "Token has expired (authState=expired). Pill is Auth expired regardless of capability. The card surfaces recovery action inline.",
      whatToCheck: [
        "Red pill 'Auth expired' in the top-right",
        "Diagnostic: 'Hasn't checked in for 8 days. Your access token has expired.'",
        "Primary 'Generate new token' button inline — NOT in the kebab",
        "Affected agents block (dimmed): 3 expanded rows with name + runtime + offline chip — operator can see which agents are stuck",
        "Footer: dimmed meta block under hairline",
      ],
      clients: [AUTH_EXPIRED],
      agents: [
        agent({ agentId: "a-dev", clientId: AUTH_EXPIRED.id, runtimeState: "offline" }),
        agent({ agentId: "a-asst", clientId: AUTH_EXPIRED.id, runtimeState: "offline" }),
        agent({ agentId: "a-rev", clientId: AUTH_EXPIRED.id, runtimeState: "offline" }),
      ],
    },
    {
      key: "setup-empty",
      group: "Setup incomplete",
      title: "Setup incomplete · no runtime installed",
      summary: "Machine connected + auth OK but no runtime is `ok`. Two install boxes shown — operator picks one.",
      whatToCheck: [
        "Yellow pill 'Setup incomplete'",
        "Two install boxes side-by-side on wide cards, stacked 1-up on narrow",
        "Each box: runtime name + headline with `command` as <code> + InlineCommand with Copy",
        "Install box has NO outer raised background — only the inner pre block is wrapped",
        "Footer meta NOT dimmed (machine is online)",
      ],
      clients: [SETUP_EMPTY],
      agents: [],
    },
    {
      key: "setup-mixed",
      group: "Setup incomplete",
      title: "Setup incomplete · one installed, one missing",
      summary: "Mixed setup: Claude Code installed (✓), Codex not installed (install box). Install-only detection.",
      whatToCheck: [
        "Claude Code row: ✓ installed v0.2.141 status line (no Connect/login affordance)",
        "Codex box: full install + login two-liner",
        "Backticks in headlines render as <code> elements, not literal backticks",
      ],
      clients: [SETUP_MIXED],
      agents: [],
    },
    {
      key: "setup-error",
      group: "Setup incomplete",
      title: "Setup incomplete · probe error on Codex",
      summary: "A runtime probe failed. Surface the error string + a reinstall command.",
      whatToCheck: [
        "Codex headline includes the error string ('ENOENT: spawn …')",
        "Codex command is the reinstall (`npm install -g @openai/codex`), no login appended",
        "Claude Code box still renders (its state is 'missing')",
        "1 agent offline — Agents block shows the agent row with its runtime + offline chip (no 'all' qualifier for total=1)",
      ],
      clients: [SETUP_ERROR],
      agents: [agent({ agentId: "a-dev", clientId: SETUP_ERROR.id, runtimeState: "offline" })],
    },
    {
      key: "offline-recent",
      group: "Offline",
      title: "Offline · 2 hours · 0 agents",
      summary: "Disconnected but auth still alive. Inline Reconnect + wake-guide command + dimmed Runtimes block.",
      whatToCheck: [
        "Grey pill 'Offline' in the top-right",
        "Diagnostic: 'Last seen 2 hours ago. Make sure the machine is awake and connected.'",
        "Inline 'Reconnect' button (was in kebab pre-PR-D2)",
        "Hint + InlineCommand with channel-aware daemon start command; Copy button flips to 'Copied' briefly on click",
        "Agents block hidden (total=0)",
        "Dimmed Runtimes block under 'last reported' label",
      ],
      clients: [OFFLINE_RECENT],
      agents: [],
    },
    {
      key: "offline-stale",
      group: "Offline",
      title: "Offline · 4 days · 2 agents",
      summary: "Stale but not expired. Agents block lists the affected agents so the operator knows what's stuck.",
      whatToCheck: [
        "Diagnostic: 'Last seen 4 days ago. …'",
        "Reconnect button visible inline (promoted from kebab)",
        "Agents block (dimmed) lists both agents with their runtime + offline chip",
        "Runtimes block (dimmed, 'last reported') shows the last-known Claude Code state",
      ],
      clients: [OFFLINE_STALE],
      agents: [
        agent({ agentId: "a-dev", clientId: OFFLINE_STALE.id, runtimeState: "offline" }),
        agent({ agentId: "a-asst", clientId: OFFLINE_STALE.id, runtimeState: "offline" }),
      ],
    },
    {
      key: "stack",
      group: "Cross-cutting",
      title: "Stack of 3 own machines (member view)",
      summary: "What a member with multiple machines sees. Hairline separators between cards.",
      whatToCheck: [
        "Top card has NO hairline above (first-child rule)",
        "Subsequent cards each get a top hairline",
        "Page subtitle reflects multi-machine summary",
        "Bottom 'Add another computer' button visible",
      ],
      clients: [READY_BOTH, AUTH_EXPIRED, OFFLINE_STALE],
      agents: [
        agent({ agentId: "a-dev", clientId: READY_BOTH.id, runtimeState: "idle" }),
        agent({ agentId: "a-asst", clientId: READY_BOTH.id, runtimeState: "idle" }),
        agent({ agentId: "a-dev", clientId: AUTH_EXPIRED.id, runtimeState: "offline" }),
        agent({ agentId: "a-asst", clientId: OFFLINE_STALE.id, runtimeState: "offline" }),
      ],
    },
    {
      key: "admin-grouped",
      group: "Cross-cutting",
      title: "Admin grouped: 2 own + 4 team machines",
      summary:
        "Admin view with 'Your computers' cards + the redesigned compact 'Team computers' list — one line per machine, health-grouped so problem machines sort to the top.",
      whatToCheck: [
        "'Your computers · 2' section as Section heading with hairline below",
        "'Team computers · 4' second Section, collapsed by default — click Show",
        "Compact list: hostname (mono, the focus) over an 'owner · OS · version' meta line",
        "'Needs attention · 2' group on top (amber header: Auth expired + Offline), then a neutral 'Ready · 2'",
        "Version drops the build suffix (0.5.2-staging.31.4 → 0.5.2); full string on hover",
        "Long hostname truncates with an ellipsis; Offline row reads 'Offline · 3 days'",
        "Owner labels: 'gandy · you' on own cards, no '· you' on team rows",
      ],
      clients: [READY_BOTH, OFFLINE_RECENT, TEAM_AUTH_EXPIRED, TEAM_OFFLINE, TEAM_MACHINE, TEAM_READY_LINUX],
      agents: [
        agent({ agentId: "a-dev", clientId: READY_BOTH.id, runtimeState: "idle" }),
        agent({ agentId: "a-asst", clientId: READY_BOTH.id, runtimeState: "idle" }),
        agent({ agentId: "a-other", clientId: TEAM_MACHINE.id, runtimeState: "idle" }),
      ],
    },
    {
      key: "empty",
      group: "Cross-cutting",
      title: "Empty state · 0 computers",
      summary: "Brand-new user with no machines connected. Centered CTA, no card stack.",
      whatToCheck: [
        "Page subtitle reads 0-machine summary",
        "Centered 'No computers connected yet' message",
        "Primary 'Connect your first computer' button (+ icon)",
        "Bottom 'Add another' button NOT shown",
      ],
      clients: [],
      agents: [],
    },
  ];

  return { scenarios, agentNames };
}

// The DEV gate here is what enables Rollup tree-shaking. In production
// builds `import.meta.env.DEV` folds to `false`, so the ternary picks
// the empty branch, `buildDemoData` becomes unreferenced, and the
// entire function body (helper fns + per-fixture consts + the
// 11-scenario array) drops out of the bundle.
const __DEMO_DATA__: { scenarios: DemoScenario[]; agentNames: Record<string, string> } = import.meta.env.DEV
  ? buildDemoData()
  : { scenarios: [], agentNames: {} };

export const DEMO_SCENARIOS: DemoScenario[] = __DEMO_DATA__.scenarios;
export const DEMO_AGENT_NAMES: Record<string, string> = __DEMO_DATA__.agentNames;

export function findDemoScenario(key: string | null | undefined): DemoScenario | null {
  if (!key) return null;
  return DEMO_SCENARIOS.find((s) => s.key === key) ?? null;
}
