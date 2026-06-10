import type { AgentVisibility, ResourceRow } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import type { HubClient } from "../api/activity.js";
import type { GithubRepo } from "../api/github.js";
import { InviteAcceptCard, InviteAcceptError, InviteAcceptShell, InviteAcceptSkeleton } from "./invite-accept.js";
import { BuildTreeShell } from "./onboarding/build-tree-shell.js";
import { COPY } from "./onboarding/copy.js";
import { WorkingState } from "./onboarding/flow-ui.js";
import { OnboardingFlowContext, type OnboardingFlowValue, type TreeMode } from "./onboarding/onboarding-flow.js";
import { OnboardingShell } from "./onboarding/onboarding-shell.js";
import { BuildTreeAgentPanel } from "./onboarding/steps/build-tree-agent-panel.js";
import { StepConnectCode } from "./onboarding/steps/step-connect-code.js";
import { StepConnectComputer } from "./onboarding/steps/step-connect-computer.js";
import { StepCreateAgent } from "./onboarding/steps/step-create-agent.js";
import { StepKickoff } from "./onboarding/steps/step-kickoff.js";
import { StepTeam } from "./onboarding/steps/step-team.js";
import { StepWelcome } from "./onboarding/steps/step-welcome.js";
import { getStepSequence, type OnboardingPath, type StepId } from "./onboarding/steps.js";
import type { ComputerConnection } from "./onboarding/use-computer-connection.js";

/**
 * DEV-only gallery of every onboarding screen + state, mounted at
 * `/preview/onboarding` (gated by `import.meta.env.DEV` in app.tsx). Renders
 * the REAL step components / shell / rail / copy — nothing is reimplemented —
 * so it stays pixel-faithful and tracks future flow changes automatically.
 *
 * How each scenario is driven:
 *   - Wizard state (`agentPhase`, `computer`, `selectedRepoUrls`, tree mode…)
 *     is injected through the real `OnboardingFlowContext`. Mutable fields are
 *     backed by local state so inputs / checkboxes / radios stay interactive.
 *   - The GitHub-backed steps fetch via React Query with inline `queryFn`s, so
 *     we can't override them through query defaults. Instead each scenario
 *     declares a tiny `net` profile and a scoped `window.fetch` shim returns
 *     canned responses for the handful of read endpoints the steps call. A
 *     fresh `QueryClient` per scenario keeps caches isolated.
 *
 * Two switcher axes (per the brief): role (Admin / Invitee) and, within a
 * role, the scenario / screen.
 */

const ORG_ID = "org-acme";
// Mirror the real signup default: the server auto-names a solo team
// `${login}'s team` (see packages/server/src/api/auth/github.ts), and the
// welcome step pre-fills the input with that value verbatim. Using the real
// shape here (vs a generic "Acme") keeps the gallery faithful for design
// review and matches the file's existing "Gandy" persona (DEFAULT_AGENT_NAME).
const TEAM_NAME = "Gandy's team";
const TREE_URL = "https://github.com/acme/context-tree";
const DEFAULT_AGENT_NAME = "Gandy's assistant";
const SAMPLE_CLI = "npm install -g <package>\n<binName> login ft_3aK9d2hQ7s_pVx1n8Wc4Lr6";

const NOW_ISO = new Date().toISOString();

const HOST: HubClient = {
  id: "client-7f3a91",
  userId: "user-1",
  status: "connected",
  authState: "ok",
  binName: "first-tree",
  sdkVersion: "0.42.0",
  hostname: "gandys-macbook",
  os: "darwin",
  agentCount: 0,
  connectedAt: NOW_ISO,
  lastSeenAt: NOW_ISO,
  capabilities: {},
};

const REPO_WEB = "https://github.com/acme/web.git";
const REPO_API = "https://github.com/acme/api.git";
const REPO_INFRA = "https://github.com/acme/infra.git";

const REPOS: GithubRepo[] = [
  {
    fullName: "acme/web",
    cloneUrl: REPO_WEB,
    htmlUrl: "https://github.com/acme/web",
    private: false,
    defaultBranch: "main",
    pushedAt: NOW_ISO,
  },
  {
    fullName: "acme/api",
    cloneUrl: REPO_API,
    htmlUrl: "https://github.com/acme/api",
    private: true,
    defaultBranch: "main",
    pushedAt: NOW_ISO,
  },
  {
    fullName: "acme/infra",
    cloneUrl: REPO_INFRA,
    htmlUrl: "https://github.com/acme/infra",
    private: true,
    defaultBranch: "main",
    pushedAt: NOW_ISO,
  },
];

const NOOP = (): void => {};
const ASYNC_NOOP = async (): Promise<void> => {};

// ── Computer-connection fixtures (drive the connect-computer + create-agent steps) ──
// `selectedRuntime` / `setSelectedRuntime` are made interactive per-scenario in
// WizardScenarioView (state-backed), so the runtime pills actually switch.
const COMPUTER: Record<
  "waiting" | "tokenError" | "detecting" | "noRuntime" | "ready" | "readyMulti",
  ComputerConnection
> = {
  waiting: {
    connectedClient: null,
    capabilitiesLoaded: false,
    okRuntimes: [],
    selectedRuntime: null,
    setSelectedRuntime: NOOP,
    cliCommand: SAMPLE_CLI,
    tokenError: null,
    retry: NOOP,
  },
  tokenError: {
    connectedClient: null,
    capabilitiesLoaded: false,
    okRuntimes: [],
    selectedRuntime: null,
    setSelectedRuntime: NOOP,
    cliCommand: null,
    tokenError: "Failed to generate connect command",
    retry: NOOP,
  },
  detecting: {
    connectedClient: HOST,
    capabilitiesLoaded: false,
    okRuntimes: [],
    selectedRuntime: null,
    setSelectedRuntime: NOOP,
    cliCommand: SAMPLE_CLI,
    tokenError: null,
    retry: NOOP,
  },
  noRuntime: {
    connectedClient: HOST,
    capabilitiesLoaded: true,
    okRuntimes: [],
    selectedRuntime: null,
    setSelectedRuntime: NOOP,
    cliCommand: SAMPLE_CLI,
    tokenError: null,
    retry: NOOP,
  },
  // Exactly one runtime → the step renders a confirmation line (no picker).
  ready: {
    connectedClient: HOST,
    capabilitiesLoaded: true,
    okRuntimes: ["claude-code"],
    selectedRuntime: "claude-code",
    setSelectedRuntime: NOOP,
    cliCommand: SAMPLE_CLI,
    tokenError: null,
    retry: NOOP,
  },
  // Multiple runtimes → the step renders the single-select runtime list.
  readyMulti: {
    connectedClient: HOST,
    capabilitiesLoaded: true,
    okRuntimes: ["claude-code", "codex", "claude-code-tui"],
    selectedRuntime: "claude-code",
    setSelectedRuntime: NOOP,
    cliCommand: SAMPLE_CLI,
    tokenError: null,
    retry: NOOP,
  },
};

// ── Invite-page preview fixtures ──
const PREVIEW = {
  organizationId: "org-acme",
  organizationName: "acme",
  organizationDisplayName: "Acme Inc",
  role: "member",
  expiresAt: null as string | null,
};
const PREVIEW_DAYS = { ...PREVIEW, expiresAt: new Date(Date.now() + 3 * 24 * 3600_000).toISOString() };
const PREVIEW_HOURS = { ...PREVIEW, expiresAt: new Date(Date.now() + 5 * 3600_000).toISOString() };

// ────────────────────────────────────────────────────────────────────────────
// Scenario network profile + scoped fetch shim
// ────────────────────────────────────────────────────────────────────────────

type RepoOutcome = GithubRepo[] | "pending" | "scope" | "neterror";

type NetProfile = {
  /** GET /me/github/repos */
  repos?: RepoOutcome;
  /** GET /orgs/:id/github-app-installation — 200 vs 404 */
  installed?: boolean;
  /** When true, the installation query never resolves (stays loading) — used to
      hold the post-click "Waiting for GitHub…" state without it flipping to stuck. */
  installPending?: boolean;
  /** GET /orgs/:id/github-app-installation/exists */
  installExists?: boolean;
  /** GET /orgs/:id/settings/context_tree → { repo } */
  contextTree?: string | null | "pending";
  /**
   * Team-recommended repos the invitee inherits. Served as ResourceRow[] from
   * GET /orgs/:id/resources (what listTeamResourcesForOrg actually calls since
   * the Resources Phase 1 refactor); InviteeKickoff filters to
   * type==="repo" && defaultEnabled==="recommended" — non-empty picks the
   * "works with your team's repos" ready copy, empty the intro copy.
   */
  sourceRepos?: string[];
  /**
   * GET /orgs/:id/github-app-installation/install-url — when set, the install
   * URL mint fails with this status, so clicking "Install on GitHub"
   * surfaces the matching installError state (503 → not_configured, 403 →
   * not_admin, else → generic). Omit it and the call falls through (real
   * fetch), so only the error scenarios opt in.
   */
  installUrlError?: 403 | 503 | 500;
};

// The active scenario's net profile, read by the shim. Set during render of the
// main panel (synchronous, before the keyed child subtree mounts and fetches).
let activeNet: NetProfile = {};

const JSON_HEADERS = { "Content-Type": "application/json" };
function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: JSON_HEADERS });
}
function statusResponse(code: number, body = ""): Response {
  return new Response(body, { status: code, headers: JSON_HEADERS });
}

function reposResponse(outcome: RepoOutcome | undefined): Promise<Response> | Response {
  if (outcome === "pending") return new Promise<Response>(() => {});
  if (outcome === "scope") return statusResponse(403, JSON.stringify({ error: "missing project read permission" }));
  if (outcome === "neterror") return Promise.reject(new TypeError("Failed to fetch"));
  return jsonResponse({ repos: outcome ?? [] });
}

/** A team-recommended repo resource, matching what GET /orgs/:id/resources returns. */
function teamRepoResource(url: string, i: number): ResourceRow {
  return {
    id: `res-${i}`,
    organizationId: ORG_ID,
    type: "repo",
    scope: "team",
    ownerAgentId: null,
    name: url.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, ""),
    repoCanonicalKey: null,
    defaultEnabled: "recommended",
    status: "active",
    payload: { url },
    createdBy: "preview",
    updatedBy: "preview",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Map a request path (with `/api/v1` prefix) to a canned response, or null to fall through. */
function handleNet(rawUrl: string): Promise<Response> | Response | null {
  const idx = rawUrl.indexOf("/api/v1");
  if (idx < 0) return null;
  const p = rawUrl.slice(idx + "/api/v1".length).split("?")[0];

  if (p === "/me/organizations") {
    return jsonResponse([{ id: ORG_ID, name: "acme", displayName: TEAM_NAME, role: "admin" }]);
  }
  // Invitee kickoff picker → /me/github/repos; admin connect-code picker →
  // the org-scoped installation repos. Both render from the same `repos`
  // outcome so existing picker scenarios cover either source.
  if (p === "/me/github/repos") return reposResponse(activeNet.repos);
  if (p === `/orgs/${ORG_ID}/github-app-installation/repositories`) return reposResponse(activeNet.repos);
  if (p === `/orgs/${ORG_ID}/github-app-installation`) {
    if (activeNet.installPending) return new Promise<Response>(() => {});
    return activeNet.installed
      ? jsonResponse({ installed: true })
      : statusResponse(404, "No GitHub App installation is bound to this team");
  }
  if (p === `/orgs/${ORG_ID}/github-app-installation/exists`) {
    return jsonResponse({ exists: !!activeNet.installExists });
  }
  if (p === `/orgs/${ORG_ID}/github-app-installation/install-url`) {
    // Only intercept when a scenario opts into an install-url failure;
    // otherwise fall through (a successful mint would navigate the preview away).
    return activeNet.installUrlError ? statusResponse(activeNet.installUrlError) : null;
  }
  if (p === `/orgs/${ORG_ID}/settings/context_tree`) {
    if (activeNet.contextTree === "pending") return new Promise<Response>(() => {});
    return jsonResponse({ repo: activeNet.contextTree ?? null });
  }
  if (p === `/orgs/${ORG_ID}/resources`) {
    return jsonResponse((activeNet.sourceRepos ?? []).map((url, i) => teamRepoResource(url, i)));
  }
  // Build-tree recovery agent picker. uuid v7 is time-ordered, so the larger
  // string is the "newest" the panel defaults to.
  if (p === "/me/managed-agents") {
    return jsonResponse([
      {
        uuid: "01920000-0000-7000-8000-00000000000b",
        name: "gandy-assistant",
        displayName: "Gandy's assistant",
        type: "agent",
        organizationId: ORG_ID,
        inboxId: "inbox-1",
        visibility: "organization",
        runtimeProvider: "claude-code",
        status: "active",
        clientId: HOST.id,
        avatarImageUrl: null,
      },
      {
        uuid: "01920000-0000-7000-8000-00000000000a",
        name: "codex-reviewer",
        displayName: "Codex reviewer",
        type: "agent",
        organizationId: ORG_ID,
        inboxId: "inbox-2",
        visibility: "organization",
        runtimeProvider: "codex",
        status: "active",
        clientId: HOST.id,
        avatarImageUrl: null,
      },
    ]);
  }
  return null;
}

// Patch window.fetch at module load (the module is only imported for this DEV
// route, so this runs before any component renders). Installing here — rather
// than in a useEffect — avoids an ordering trap: effects run child-first, so a
// step's own fetch would fire before a parent effect could install the shim.
// Interception is gated to the preview path, so navigating away (or the rest of
// the app) is unaffected; the true original is stashed on window so HMR
// re-imports re-wrap the real fetch instead of stacking.
interface WindowWithOrigFetch extends Window {
  __ftOrigFetch?: typeof fetch;
}
const previewWindow: WindowWithOrigFetch = window;
previewWindow.__ftOrigFetch ??= window.fetch;
const originalFetch = previewWindow.__ftOrigFetch;
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (window.location.pathname.startsWith("/preview/onboarding")) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const handled = handleNet(url);
    if (handled !== null) return Promise.resolve(handled);
  }
  return originalFetch(input, init);
};

// ────────────────────────────────────────────────────────────────────────────
// Scenario catalog
// ────────────────────────────────────────────────────────────────────────────

type Role = OnboardingPath;

type WizardSpec = {
  step: StepId;
  flow?: Partial<OnboardingFlowValue>;
  net?: NetProfile;
  /**
   * Render under the standalone build-tree recovery chrome (`BuildTreeShell`)
   * instead of the onboarding shell — the recovery surface reuses the same step
   * components, only the chrome differs.
   */
  shell?: "build-tree";
  /** Override the rendered body (used for transient working states). */
  body?: ReactNode;
  /**
   * Seed the connect-code "returned from GitHub without an install" marker so
   * the post-attempt stuck path fires (auto-opens Need help? after the
   * component's short delay). Mirrors the per-tab key StepConnectCode sets.
   */
  seedInstallAttempt?: boolean;
  /**
   * Render connect-computer in its "stuck" state (help auto-opens, label flips
   * to "Taking a while?"). The real state is gated on a 75s internal timer
   * (STUCK_AFTER_MS) that fixtures can't force, so the preview seeds it directly
   * via StepConnectComputer's `initialStuck` prop.
   */
  connectStuck?: boolean;
};

// Per-tab marker StepConnectCode reads to detect "came back without an install"
// (kept in sync with the literal in step-connect-code.tsx).
const INSTALL_ATTEMPT_KEY = "onboarding:connect-code:install-attempt";

type Scenario = {
  id: string;
  label: string;
  group: string;
  role: Role;
  wizard?: WizardSpec;
  invite?: ReactNode;
};

const SCENARIOS: Scenario[] = [
  // ── ADMIN ──────────────────────────────────────────────────────────────
  { id: "admin-team", label: "Name your team", group: "1 · Team", role: "admin", wizard: { step: "team" } },

  {
    id: "admin-cc-waiting",
    label: "Waiting for computer",
    group: "2 · Connect computer",
    role: "admin",
    wizard: { step: "connect-computer", flow: { computer: COMPUTER.waiting } },
  },
  {
    id: "admin-cc-tokenerr",
    label: "Connect-token error",
    group: "2 · Connect computer",
    role: "admin",
    wizard: { step: "connect-computer", flow: { computer: COMPUTER.tokenError } },
  },
  {
    id: "admin-cc-detecting",
    label: "Connected · detecting",
    group: "2 · Connect computer",
    role: "admin",
    wizard: { step: "connect-computer", flow: { computer: COMPUTER.detecting } },
  },
  {
    id: "admin-cc-noruntime",
    label: "Connected · no AI tool",
    group: "2 · Connect computer",
    role: "admin",
    wizard: { step: "connect-computer", flow: { computer: COMPUTER.noRuntime } },
  },
  {
    id: "admin-cc-ready",
    label: "Connected · ready (1 runtime)",
    group: "2 · Connect computer",
    role: "admin",
    wizard: { step: "connect-computer", flow: { computer: COMPUTER.ready } },
  },
  {
    id: "admin-cc-ready-multi",
    label: "Connected · ready (multiple runtimes)",
    group: "2 · Connect computer",
    role: "admin",
    wizard: { step: "connect-computer", flow: { computer: COMPUTER.readyMulti } },
  },
  {
    id: "admin-cc-stuck",
    label: "Waiting · stuck (Need help)",
    group: "2 · Connect computer",
    role: "admin",
    wizard: { step: "connect-computer", flow: { computer: COMPUTER.waiting }, connectStuck: true },
  },

  {
    id: "admin-ca-form",
    label: "Form (idle)",
    group: "3 · Create agent",
    role: "admin",
    wizard: { step: "create-agent", flow: { computer: COMPUTER.ready, agentPhase: "idle" } },
  },
  {
    id: "admin-ca-creating",
    label: "Creating…",
    group: "3 · Create agent",
    role: "admin",
    wizard: { step: "create-agent", flow: { computer: COMPUTER.ready, agentPhase: "creating" } },
  },
  {
    id: "admin-ca-timeout",
    label: "Timeout",
    group: "3 · Create agent",
    role: "admin",
    wizard: { step: "create-agent", flow: { computer: COMPUTER.ready, agentPhase: "timeout" } },
  },
  {
    id: "admin-ca-error",
    label: "Create error",
    group: "3 · Create agent",
    role: "admin",
    wizard: {
      step: "create-agent",
      flow: { computer: COMPUTER.ready, agentPhase: "idle", agentError: "Couldn't create your agent" },
    },
  },
  {
    id: "admin-ca-computer-lost",
    label: "Form · computer disconnected",
    group: "3 · Create agent",
    role: "admin",
    wizard: { step: "create-agent", flow: { computer: COMPUTER.waiting, agentPhase: "idle" } },
  },

  {
    id: "admin-code-notinstalled",
    label: "Not installed",
    group: "4 · Connect code",
    role: "admin",
    wizard: { step: "connect-code", net: { installed: false } },
  },
  {
    id: "admin-code-err-notconfigured",
    label: "Install error · can't connect · 503 (click Install)",
    group: "4 · Connect code",
    role: "admin",
    wizard: { step: "connect-code", net: { installed: false, installUrlError: 503 } },
  },
  {
    id: "admin-code-err-notadmin",
    label: "Install error · can't connect · 403 (click Install)",
    group: "4 · Connect code",
    role: "admin",
    wizard: { step: "connect-code", net: { installed: false, installUrlError: 403 } },
  },
  {
    id: "admin-code-err-generic",
    label: "Install error · generic (click Install)",
    group: "4 · Connect code",
    role: "admin",
    wizard: { step: "connect-code", net: { installed: false, installUrlError: 500 } },
  },
  {
    id: "admin-code-waiting",
    label: "Waiting for GitHub (after click)",
    group: "4 · Connect code",
    role: "admin",
    // installPending keeps the install query loading so it holds "Waiting for
    // GitHub…" without the 5s stuck timer firing; seedInstallAttempt marks the
    // click so the status shows (pre-click there's nothing to wait for).
    wizard: { step: "connect-code", net: { installPending: true }, seedInstallAttempt: true },
  },
  {
    id: "admin-code-stuck",
    label: "Came back without install (stuck → Need help)",
    group: "4 · Connect code",
    role: "admin",
    wizard: { step: "connect-code", net: { installed: false }, seedInstallAttempt: true },
  },
  {
    id: "admin-code-loading",
    label: "Loading repos",
    group: "4 · Connect code",
    role: "admin",
    wizard: { step: "connect-code", net: { installed: true, repos: "pending" } },
  },
  {
    id: "admin-code-norepos",
    label: "No repos",
    group: "4 · Connect code",
    role: "admin",
    wizard: { step: "connect-code", net: { installed: true, repos: [] } },
  },
  {
    id: "admin-code-loadfailed",
    label: "Load failed",
    group: "4 · Connect code",
    role: "admin",
    wizard: { step: "connect-code", net: { installed: true, repos: "neterror" } },
  },
  {
    id: "admin-code-repos",
    label: "Pick repos",
    group: "4 · Connect code",
    role: "admin",
    wizard: { step: "connect-code", net: { installed: true, repos: REPOS } },
  },

  {
    id: "admin-ko-noproject",
    label: "No repo",
    group: "5 · Kickoff",
    role: "admin",
    wizard: { step: "kickoff", flow: { selectedRepoUrls: [] } },
  },
  {
    id: "admin-ko-new",
    label: "New tree (default)",
    group: "5 · Kickoff",
    role: "admin",
    wizard: { step: "kickoff", flow: { selectedRepoUrls: [REPO_WEB], treeMode: "new" }, net: { contextTree: null } },
  },
  {
    id: "admin-ko-existing",
    label: "Existing (auto-detected)",
    group: "5 · Kickoff",
    role: "admin",
    wizard: { step: "kickoff", flow: { selectedRepoUrls: [REPO_WEB] }, net: { contextTree: TREE_URL } },
  },
  {
    id: "admin-ko-checking",
    label: "Checking team setup",
    group: "5 · Kickoff",
    role: "admin",
    wizard: { step: "kickoff", flow: { selectedRepoUrls: [REPO_WEB] }, net: { contextTree: "pending" } },
  },
  {
    id: "admin-ko-starting",
    label: "Starting…",
    group: "5 · Kickoff",
    role: "admin",
    wizard: {
      step: "kickoff",
      flow: { selectedRepoUrls: [REPO_WEB] },
      body: <WorkingState label={COPY.kickoff.starting} />,
    },
  },

  // ── BUILD TREE (recovery) ───────────────────────────────────────────────
  // The standalone "build your Context Tree" surface for an admin who completed
  // onboarding without connecting code. Reuses connect-code + kickoff under
  // BuildTreeShell; step 1 requires a repo, the agent picker lives on step 2.
  {
    id: "admin-bt-connect",
    label: "Connect code (repo required)",
    group: "6 · Build tree (recovery)",
    role: "admin",
    wizard: {
      step: "connect-code",
      shell: "build-tree",
      net: { installed: true, repos: REPOS },
      // `recovery` → no skip / continue-without-a-repo; Continue is disabled
      // until a repo is selected.
      body: <StepConnectCode recovery />,
    },
  },
  {
    id: "admin-bt-build",
    label: "Build + pick agent (kickoff)",
    group: "6 · Build tree (recovery)",
    role: "admin",
    wizard: {
      step: "kickoff",
      shell: "build-tree",
      flow: { selectedRepoUrls: [REPO_WEB, REPO_API], treeMode: "new" },
      net: { contextTree: null },
      // `recovery` → no per-step heading (the shell's constant title carries it).
      // The agent picker lives on THIS step, above the CTA.
      body: <StepKickoff recovery agentPicker={<BuildTreeAgentPanel />} />,
    },
  },

  // ── INVITEE ────────────────────────────────────────────────────────────
  {
    id: "inv-link-loading",
    label: "Loading",
    group: "0 · Invite link (pre-login)",
    role: "invitee",
    invite: <InviteAcceptSkeleton />,
  },
  {
    id: "inv-link-invalid",
    label: "Invalid / expired",
    group: "0 · Invite link (pre-login)",
    role: "invitee",
    invite: <InviteAcceptError message="This invitation is no longer valid" />,
  },
  {
    id: "inv-link-signedout",
    label: "Signed out",
    group: "0 · Invite link (pre-login)",
    role: "invitee",
    invite: (
      <InviteAcceptCard
        preview={PREVIEW}
        isAuthenticated={false}
        currentTeamName={null}
        busy={false}
        onJoin={NOOP}
        oauthHref="#"
      />
    ),
  },
  {
    id: "inv-link-signedin",
    label: "Signed in · join",
    group: "0 · Invite link (pre-login)",
    role: "invitee",
    invite: (
      <InviteAcceptCard
        preview={PREVIEW}
        isAuthenticated
        currentTeamName={null}
        busy={false}
        onJoin={NOOP}
        oauthHref="#"
      />
    ),
  },
  {
    id: "inv-link-switch",
    label: "Team switch warning",
    group: "0 · Invite link (pre-login)",
    role: "invitee",
    invite: (
      <InviteAcceptCard
        preview={PREVIEW}
        isAuthenticated
        currentTeamName="Globex"
        busy={false}
        onJoin={NOOP}
        oauthHref="#"
      />
    ),
  },
  {
    id: "inv-link-exp-days",
    label: "Expiry · days",
    group: "0 · Invite link (pre-login)",
    role: "invitee",
    invite: (
      <InviteAcceptCard
        preview={PREVIEW_DAYS}
        isAuthenticated={false}
        currentTeamName={null}
        busy={false}
        onJoin={NOOP}
        oauthHref="#"
      />
    ),
  },
  {
    id: "inv-link-exp-hours",
    label: "Expiry · hours (urgent)",
    group: "0 · Invite link (pre-login)",
    role: "invitee",
    invite: (
      <InviteAcceptCard
        preview={PREVIEW_HOURS}
        isAuthenticated={false}
        currentTeamName={null}
        busy={false}
        onJoin={NOOP}
        oauthHref="#"
      />
    ),
  },

  {
    id: "inv-welcome",
    label: "Welcome to the team",
    group: "1 · Welcome",
    role: "invitee",
    wizard: { step: "welcome", flow: { teamDisplayName: "Acme Inc" } },
  },

  {
    id: "inv-cc-waiting",
    label: "Waiting for computer",
    group: "2 · Connect computer",
    role: "invitee",
    wizard: { step: "connect-computer", flow: { computer: COMPUTER.waiting } },
  },
  {
    id: "inv-cc-tokenerr",
    label: "Connect-token error",
    group: "2 · Connect computer",
    role: "invitee",
    wizard: { step: "connect-computer", flow: { computer: COMPUTER.tokenError } },
  },
  {
    id: "inv-cc-detecting",
    label: "Connected · detecting",
    group: "2 · Connect computer",
    role: "invitee",
    wizard: { step: "connect-computer", flow: { computer: COMPUTER.detecting } },
  },
  {
    id: "inv-cc-noruntime",
    label: "Connected · no AI tool",
    group: "2 · Connect computer",
    role: "invitee",
    wizard: { step: "connect-computer", flow: { computer: COMPUTER.noRuntime } },
  },
  {
    id: "inv-cc-ready",
    label: "Connected · ready (1 runtime)",
    group: "2 · Connect computer",
    role: "invitee",
    wizard: { step: "connect-computer", flow: { computer: COMPUTER.ready } },
  },
  {
    id: "inv-cc-ready-multi",
    label: "Connected · ready (multiple runtimes)",
    group: "2 · Connect computer",
    role: "invitee",
    wizard: { step: "connect-computer", flow: { computer: COMPUTER.readyMulti } },
  },
  {
    id: "inv-cc-stuck",
    label: "Waiting · stuck (Need help)",
    group: "2 · Connect computer",
    role: "invitee",
    wizard: { step: "connect-computer", flow: { computer: COMPUTER.waiting }, connectStuck: true },
  },

  {
    id: "inv-ca-form",
    label: "Form (idle)",
    group: "3 · Create agent",
    role: "invitee",
    wizard: { step: "create-agent", flow: { computer: COMPUTER.ready, agentPhase: "idle" } },
  },
  {
    id: "inv-ca-creating",
    label: "Creating…",
    group: "3 · Create agent",
    role: "invitee",
    wizard: { step: "create-agent", flow: { computer: COMPUTER.ready, agentPhase: "creating" } },
  },
  {
    id: "inv-ca-timeout",
    label: "Timeout",
    group: "3 · Create agent",
    role: "invitee",
    wizard: { step: "create-agent", flow: { computer: COMPUTER.ready, agentPhase: "timeout" } },
  },
  {
    id: "inv-ca-error",
    label: "Create error",
    group: "3 · Create agent",
    role: "invitee",
    wizard: {
      step: "create-agent",
      flow: { computer: COMPUTER.ready, agentPhase: "idle", agentError: "Couldn't create your agent" },
    },
  },
  {
    id: "inv-ca-computer-lost",
    label: "Form · computer disconnected",
    group: "3 · Create agent",
    role: "invitee",
    wizard: { step: "create-agent", flow: { computer: COMPUTER.waiting, agentPhase: "idle" } },
  },

  {
    id: "inv-ko-waiting",
    label: "Waiting for team",
    group: "4 · Kickoff (start work)",
    role: "invitee",
    wizard: { step: "kickoff", net: { installExists: true } },
  },
  {
    id: "inv-ko-noinstall",
    label: "No code connection",
    group: "4 · Kickoff (start work)",
    role: "invitee",
    wizard: { step: "kickoff", net: { contextTree: TREE_URL, installExists: false } },
  },
  {
    id: "inv-ko-ready",
    label: "Ready · team has repos",
    group: "4 · Kickoff (start work)",
    role: "invitee",
    wizard: { step: "kickoff", net: { contextTree: TREE_URL, installExists: true, sourceRepos: [REPO_WEB, REPO_API] } },
  },
  {
    id: "inv-ko-ready-norepos",
    label: "Ready · no team repos (intro)",
    group: "4 · Kickoff (start work)",
    role: "invitee",
    wizard: { step: "kickoff", net: { contextTree: TREE_URL, installExists: true, sourceRepos: [] } },
  },
  {
    id: "inv-ko-starting",
    label: "Starting…",
    group: "4 · Kickoff (start work)",
    role: "invitee",
    wizard: { step: "kickoff", body: <WorkingState label={COPY.kickoff.starting} /> },
  },
];

// ────────────────────────────────────────────────────────────────────────────
// Flow value + wizard renderer
// ────────────────────────────────────────────────────────────────────────────

function baseFlow(path: OnboardingPath): OnboardingFlowValue {
  const sequence = getStepSequence(path);
  return {
    path,
    sequence,
    activeIndex: 0,
    activeStep: sequence[0] as StepId,
    goNext: NOOP,
    goTo: NOOP,
    organizationId: ORG_ID,
    memberId: "mem-preview",
    role: path === "admin" ? "admin" : "member",
    username: "gandy",
    teamDisplayName: TEAM_NAME,
    orgHasOtherMembers: path === "invitee",
    computer: COMPUTER.waiting,
    agentDisplayName: DEFAULT_AGENT_NAME,
    setAgentDisplayName: NOOP,
    visibility: "organization",
    setVisibility: NOOP,
    agentPhase: "idle",
    agentError: null,
    createAgent: ASYNC_NOOP,
    retryAgent: ASYNC_NOOP,
    createdAgentUuid: null,
    hasAgent: false,
    selectedRepoUrls: [],
    setSelectedRepoUrls: NOOP,
    treeMode: "new",
    setTreeMode: NOOP,
    treeUrl: "",
    setTreeUrl: NOOP,
    treeAutoInitDone: false,
    markTreeAutoInitDone: NOOP,
    completeAndEnterChat: ASYNC_NOOP,
    finishLater: ASYNC_NOOP,
  };
}

function StepBody({ step, connectStuck }: { step: StepId; connectStuck?: boolean }): ReactNode {
  switch (step) {
    case "team":
      return <StepTeam />;
    case "connect-code":
      return <StepConnectCode />;
    case "connect-computer":
      return <StepConnectComputer initialStuck={connectStuck} />;
    case "create-agent":
      return <StepCreateAgent />;
    case "kickoff":
      return <StepKickoff />;
    case "welcome":
      return <StepWelcome />;
    default:
      return null;
  }
}

/** Renders one wizard scenario at full fidelity. Remounted per scenario via key. */
function WizardScenarioView({ spec, role }: { spec: WizardSpec; role: Role }) {
  const path: OnboardingPath = role;
  const sequence = getStepSequence(path);
  const activeIndex = Math.max(0, sequence.indexOf(spec.step));
  const init = spec.flow ?? {};

  const [agentDisplayName, setAgentDisplayName] = useState<string>(init.agentDisplayName ?? DEFAULT_AGENT_NAME);
  const [visibility, setVisibility] = useState<AgentVisibility>(init.visibility ?? "organization");
  const [selectedRepoUrls, setSelectedRepoUrls] = useState<string[]>(init.selectedRepoUrls ?? []);
  const [treeMode, setTreeMode] = useState<TreeMode>(init.treeMode ?? "new");
  const [treeUrl, setTreeUrl] = useState<string>(init.treeUrl ?? "");
  const [treeAutoInitDone, setTreeAutoInitDone] = useState<boolean>(init.treeAutoInitDone ?? false);
  // Back the injected computer's runtime selection with local state so the
  // single-select runtime pills actually switch when clicked.
  const [selectedRuntime, setSelectedRuntime] = useState<string | null>(init.computer?.selectedRuntime ?? null);

  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }),
    [],
  );

  const base = baseFlow(path);
  const flow: OnboardingFlowValue = {
    ...base,
    ...init,
    path,
    sequence,
    activeIndex,
    activeStep: spec.step,
    agentDisplayName,
    setAgentDisplayName,
    visibility,
    setVisibility,
    selectedRepoUrls,
    setSelectedRepoUrls,
    treeMode,
    setTreeMode,
    treeUrl,
    setTreeUrl,
    treeAutoInitDone,
    markTreeAutoInitDone: () => setTreeAutoInitDone(true),
    // Override the injected computer's runtime selection with the stateful
    // pair so clicking a runtime pill re-renders with the new choice.
    computer: init.computer ? { ...init.computer, selectedRuntime, setSelectedRuntime } : base.computer,
  };

  const Shell = spec.shell === "build-tree" ? BuildTreeShell : OnboardingShell;

  return (
    <QueryClientProvider client={queryClient}>
      <OnboardingFlowContext.Provider value={flow}>
        <Shell>{spec.body ?? <StepBody step={spec.step} connectStuck={spec.connectStuck} />}</Shell>
      </OnboardingFlowContext.Provider>
    </QueryClientProvider>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Page (switcher + main panel)
// ────────────────────────────────────────────────────────────────────────────

export function OnboardingPreviewPage() {
  const [role, setRole] = useState<Role>("admin");
  const roleScenarios = useMemo(() => SCENARIOS.filter((s) => s.role === role), [role]);
  const [scenarioId, setScenarioId] = useState<string>(roleScenarios[0]?.id ?? "");

  const active = roleScenarios.find((s) => s.id === scenarioId) ?? roleScenarios[0];

  const switchRole = (next: Role): void => {
    setRole(next);
    const first = SCENARIOS.find((s) => s.role === next);
    if (first) setScenarioId(first.id);
  };

  // Set the net profile for the active wizard scenario BEFORE the keyed child
  // subtree below mounts and fetches. Render is synchronous and parent-first,
  // so the shim sees the right profile by the time the step components fetch.
  activeNet = active?.wizard?.net ?? {};
  // Seed / clear the connect-code post-attempt marker for the matching scenario
  // (synchronous, before the keyed child mounts and its effect reads it).
  if (typeof window !== "undefined") {
    if (active?.wizard?.seedInstallAttempt) window.sessionStorage.setItem(INSTALL_ATTEMPT_KEY, "preview");
    else window.sessionStorage.removeItem(INSTALL_ATTEMPT_KEY);
  }

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden", background: "var(--bg)" }}>
      <aside
        style={{
          width: 288,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          borderRight: "var(--hairline) solid var(--border)",
          background: "var(--bg-raised)",
          overflowY: "auto",
        }}
      >
        <div style={{ padding: "var(--sp-4) var(--sp-4) var(--sp-3)" }}>
          <h1 className="text-subtitle font-semibold" style={{ margin: 0, color: "var(--fg)" }}>
            Onboarding · Preview
          </h1>
          <p className="text-label" style={{ margin: "var(--sp-1) 0 0", color: "var(--fg-4)" }}>
            DEV-only. Real components, mocked state.
          </p>
        </div>

        {/* Axis 1 — role */}
        <div style={{ padding: "0 var(--sp-4) var(--sp-3)" }}>
          <div
            className="flex"
            style={{
              gap: 2,
              padding: 2,
              borderRadius: "var(--radius-input)",
              background: "var(--bg-sunken)",
              border: "var(--hairline) solid var(--border-faint)",
            }}
          >
            {(["admin", "invitee"] as const).map((r) => {
              const on = role === r;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => switchRole(r)}
                  className="text-label font-medium"
                  style={{
                    flex: 1,
                    padding: "var(--sp-1_5) var(--sp-2)",
                    borderRadius: "var(--radius-chip)",
                    border: 0,
                    cursor: "pointer",
                    textTransform: "capitalize",
                    background: on ? "var(--bg-raised)" : "transparent",
                    color: on ? "var(--fg)" : "var(--fg-3)",
                    boxShadow: on ? "var(--shadow-sm)" : "none",
                  }}
                >
                  {r}
                </button>
              );
            })}
          </div>
        </div>

        {/* Axis 2 — scenario list, grouped by step */}
        <nav style={{ padding: "0 var(--sp-2) var(--sp-4)", flex: 1 }}>
          {roleScenarios.map((s, i) => {
            const newGroup = i === 0 || roleScenarios[i - 1]?.group !== s.group;
            const on = active?.id === s.id;
            return (
              <div key={s.id}>
                {newGroup && (
                  <p
                    className="text-caption mono"
                    style={{
                      margin: "var(--sp-3) var(--sp-2) var(--sp-1)",
                      color: "var(--fg-4)",
                      textTransform: "uppercase",
                    }}
                  >
                    {s.group}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => setScenarioId(s.id)}
                  className="text-label w-full text-left"
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "var(--sp-1_5) var(--sp-2)",
                    borderRadius: "var(--radius-input)",
                    border: 0,
                    cursor: "pointer",
                    background: on ? "color-mix(in oklch, var(--primary) 12%, transparent)" : "transparent",
                    color: on ? "var(--fg)" : "var(--fg-2)",
                    fontWeight: on ? 600 : 400,
                  }}
                >
                  {s.label}
                </button>
              </div>
            );
          })}
        </nav>

        <ThemeToggle />
      </aside>

      <main style={{ flex: 1, minWidth: 0, overflow: "hidden", position: "relative" }}>
        {active?.wizard ? (
          <WizardScenarioView key={active.id} spec={active.wizard} role={active.role} />
        ) : active?.invite ? (
          <div key={active.id} style={{ height: "100%", overflowY: "auto" }}>
            <InviteAcceptShell>{active.invite}</InviteAcceptShell>
          </div>
        ) : null}
      </main>
    </div>
  );
}

function ThemeToggle() {
  return (
    <div
      style={{
        padding: "var(--sp-3) var(--sp-4)",
        borderTop: "var(--hairline) solid var(--border-faint)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <span className="text-label mono" style={{ color: "var(--fg-4)" }}>
        theme
      </span>
      <button
        type="button"
        className="text-caption mono"
        onClick={() => {
          const dark = document.documentElement.classList.toggle("dark");
          window.localStorage.setItem("theme", dark ? "dark" : "light");
        }}
        style={{
          padding: "var(--sp-1) var(--sp-2)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-input)",
          background: "var(--bg-hover)",
          color: "var(--fg-2)",
          cursor: "pointer",
        }}
      >
        toggle
      </button>
    </div>
  );
}
