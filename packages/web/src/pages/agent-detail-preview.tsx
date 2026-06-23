import type {
  Agent,
  AgentResourcesOutput,
  AgentRuntimeConfig,
  UsageAgentSummary,
  UsageTurnsResponse,
} from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Outlet, Route, Routes } from "react-router";
import { AgentSwitcherStrip } from "./agent-detail/agent-switcher-strip.js";
import { ResourceTypeSection } from "./agent-detail/capability-section.js";
import type { AgentDetailContext } from "./agent-detail/layout-context.js";
import { PromptTab } from "./agent-detail/prompt-tab.js";
import { ResourcesTab } from "./agent-detail/resources-tab.js";
import { RuntimeSection } from "./agent-detail/runtime-section.js";
import { UsageTab } from "./agent-detail/usage-tab.js";

/**
 * DEV-only visual preview of the redesigned agent-detail **Capabilities** and
 * **Prompt** tabs, mounted at `/preview/agent-detail` (gated by
 * `import.meta.env.DEV` in app.tsx).
 *
 * It renders the REAL `ResourcesTab` / `PromptTab` components, fed by a seeded
 * QueryClient + a mock outlet context — no backend, no auth. The sample data is
 * crafted so every label / marker / control is visible at once:
 *   - source labels: `From your team` vs `Added by you`
 *   - status markers: `Overridden`, `Can't load` (plain disabled is conveyed by
 *     the Switch in its off position + a greyed row, not a badge)
 *   - controls: the on/off Switch (team-recommended only) + the ⋯ overflow menu
 *     (Customize / Edit / Remove). Opt-in and custom rows have no Switch.
 *
 * This page is for looking, not round-tripping — clicking a mutating button hits
 * the real API and will fail without a server.
 */

const NOW = "2026-06-04T00:00:00.000Z";
const UUID = "agent-preview";

const RESOURCES: AgentResourcesOutput = {
  version: 7,
  effective: {
    version: 7,
    repos: [
      {
        id: "eff:repo:team",
        bindingId: null,
        resourceId: "repo-team",
        replacesResourceId: null,
        type: "repo",
        name: "first-tree",
        scope: "team",
        source: "team_recommended",
        mode: "enabled",
        defaultEnabled: "recommended",
        payload: { url: "https://github.com/agent-team-foundation/first-tree.git" },
        repo: { url: "https://github.com/agent-team-foundation/first-tree.git", localPath: "first-tree" },
        promptBody: null,
        unavailableReason: null,
        order: 0,
      },
      {
        id: "eff:repo:extra",
        bindingId: "bind-repo-extra",
        resourceId: null,
        replacesResourceId: null,
        type: "repo",
        name: "my-scratch-repo",
        scope: null,
        source: "agent_extra",
        mode: "enabled",
        defaultEnabled: null,
        payload: { url: "https://github.com/me/my-scratch-repo.git" },
        repo: { url: "https://github.com/me/my-scratch-repo.git", localPath: "my-scratch-repo" },
        promptBody: null,
        unavailableReason: null,
        order: 1,
      },
      {
        id: "eff:repo:broken",
        bindingId: null,
        resourceId: "repo-broken",
        replacesResourceId: null,
        type: "repo",
        name: "archived-repo",
        scope: "team",
        source: "team_recommended",
        mode: "unavailable",
        defaultEnabled: "recommended",
        payload: { url: "https://github.com/agent-team-foundation/archived-repo.git" },
        repo: null,
        promptBody: null,
        unavailableReason: "Repository not found",
        order: 2,
      },
    ],
    prompts: [
      {
        id: "eff:prompt:team",
        bindingId: null,
        resourceId: "prompt-style",
        replacesResourceId: null,
        type: "prompt",
        name: "Team style guide",
        scope: "team",
        source: "team_recommended",
        mode: "enabled",
        defaultEnabled: "recommended",
        payload: null,
        repo: null,
        promptBody:
          "Follow the team house style when reviewing diffs.\n\n- Prefer small, focused changes.\n- Call out missing tests and error handling.\n- Flag any public-API change for a second reviewer.\n- Keep comments about the code, not the author.",
        unavailableReason: null,
        order: 0,
      },
      {
        id: "eff:prompt:inline",
        bindingId: "bind-inline",
        resourceId: null,
        replacesResourceId: null,
        type: "prompt",
        name: "Inline prompt",
        scope: null,
        source: "inline_prompt",
        mode: "enabled",
        defaultEnabled: null,
        payload: null,
        repo: null,
        promptBody: "Always summarize tradeoffs before recommending.",
        unavailableReason: null,
        order: 1,
      },
      {
        id: "eff:prompt:disabled",
        bindingId: "bind-disable",
        resourceId: "prompt-tone",
        replacesResourceId: null,
        type: "prompt",
        name: "Formal tone",
        scope: "team",
        source: "team_recommended",
        mode: "disabled",
        defaultEnabled: "recommended",
        payload: null,
        repo: null,
        promptBody: "Keep a formal tone in all replies.",
        unavailableReason: null,
        order: 2,
      },
      {
        // Team prompt the agent overrode with its own version → the original
        // shows the `Overridden` badge (the custom replacement is its own row).
        id: "eff:prompt:replaced",
        bindingId: "bind-replace",
        resourceId: "prompt-review",
        replacesResourceId: null,
        type: "prompt",
        name: "Review checklist",
        scope: "team",
        source: "team_recommended",
        mode: "replaced",
        defaultEnabled: "recommended",
        payload: null,
        repo: null,
        promptBody: "Use the team's standard review checklist.",
        unavailableReason: null,
        order: 3,
      },
    ],
    skills: [
      {
        id: "eff:skill:team",
        bindingId: null,
        resourceId: "skill-release",
        replacesResourceId: null,
        type: "skill",
        name: "release-notes",
        scope: "team",
        source: "team_recommended",
        mode: "enabled",
        defaultEnabled: "recommended",
        payload: {
          name: "release-notes",
          description: "Draft release notes from a merged PR range.",
          body: "",
          metadata: {},
        },
        repo: null,
        promptBody: null,
        unavailableReason: null,
        order: 0,
      },
      {
        // Opt-in team skill the agent enabled for itself: no Switch (present-or-
        // removed) — managed via the ⋯ Remove + the section "+".
        id: "eff:skill:optin",
        bindingId: "bind-skill-optin",
        resourceId: "skill-optin",
        replacesResourceId: null,
        type: "skill",
        name: "pr-summary",
        scope: "team",
        source: "team_available",
        mode: "enabled",
        defaultEnabled: "available",
        payload: { name: "pr-summary", description: "Summarize a PR for reviewers.", body: "", metadata: {} },
        repo: null,
        promptBody: null,
        unavailableReason: null,
        order: 1,
      },
    ],
    mcp: [
      {
        id: "eff:mcp:team",
        bindingId: null,
        resourceId: "mcp-github",
        replacesResourceId: null,
        type: "mcp",
        name: "github",
        scope: "team",
        source: "team_recommended",
        mode: "enabled",
        defaultEnabled: "recommended",
        payload: { name: "github", transport: "http", url: "https://mcp.example.com/github" },
        repo: null,
        promptBody: null,
        unavailableReason: null,
        order: 0,
      },
    ],
    unavailable: [],
  },
  bindings: [
    { id: "bind-repo-extra", type: "repo", mode: "include", resourceId: null, replacesResourceId: null, order: 1 },
    {
      id: "bind-skill-optin",
      type: "skill",
      mode: "include",
      resourceId: "skill-optin",
      replacesResourceId: null,
      order: 4,
    },
    {
      id: "bind-inline",
      type: "prompt",
      mode: "include",
      resourceId: null,
      replacesResourceId: null,
      inlinePromptBody: "Always summarize tradeoffs before recommending.",
      order: 1,
    },
    {
      id: "bind-disable",
      type: "prompt",
      mode: "disable",
      resourceId: "prompt-tone",
      replacesResourceId: null,
      order: 2,
    },
    {
      id: "bind-replace",
      type: "prompt",
      mode: "replace",
      resourceId: null,
      replacesResourceId: "prompt-review",
      inlinePromptBody: "Use our stricter, security-focused review checklist.",
      order: 6,
    },
    {
      // An inline prompt binding the backend kept but produced no effective row
      // for (empty body) — recovered as an "orphan" row so it's editable/removable.
      id: "bind-orphan",
      type: "prompt",
      mode: "include",
      resourceId: null,
      replacesResourceId: null,
      inlinePromptBody: "",
      order: 5,
    },
  ],
  availableTeamResources: [
    {
      id: "skill-changelog",
      organizationId: "org-preview",
      type: "skill",
      scope: "team",
      ownerAgentId: null,
      name: "changelog",
      repoCanonicalKey: null,
      defaultEnabled: "available",
      status: "active",
      payload: { name: "changelog", description: "Maintain a CHANGELOG.", body: "", metadata: {} },
      createdBy: "preview",
      updatedBy: "preview",
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: "prompt-security",
      organizationId: "org-preview",
      type: "prompt",
      scope: "team",
      ownerAgentId: null,
      name: "Security review checklist",
      repoCanonicalKey: null,
      defaultEnabled: "available",
      status: "active",
      payload: { description: "Checklist to run before approving security-sensitive diffs." },
      createdBy: "preview",
      updatedBy: "preview",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ],
};

const AGENT: Agent = {
  uuid: UUID,
  name: "vega",
  displayName: "Vega",
  type: "agent",
  managerId: "member-self",
  visibility: "organization",
  avatarColorToken: null,
  avatarImageUrl: null,
  status: "active",
  organizationId: "org-preview",
  delegateMention: null,
  inboxId: "inbox-preview",
  metadata: {},
  source: "portal",
  clientId: "client-preview",
  runtimeProvider: "claude-code",
  runtimeState: "idle",
  createdAt: NOW,
  updatedAt: NOW,
};

const CONFIG: AgentRuntimeConfig = {
  agentId: UUID,
  version: 7,
  payload: {
    kind: "claude-code",
    prompt: {
      append:
        "Follow the team house style when reviewing diffs.\n\n- Prefer small, focused changes.\n- Call out missing tests and error handling.\n- Flag any public-API change for a second reviewer.\n- Keep comments about the code, not the author.\n\nAlways summarize tradeoffs before recommending.",
      sections: [
        {
          scope: "team",
          name: "Team style guide",
          body: "Follow the team house style when reviewing diffs.\n\n- Prefer small, focused changes.\n- Call out missing tests and error handling.\n- Flag any public-API change for a second reviewer.\n- Keep comments about the code, not the author.",
        },
        { scope: "agent", name: "", body: "Always summarize tradeoffs before recommending.", editable: true },
      ],
    },
    model: "sonnet",
    reasoningEffort: "high",
    mcpServers: [],
    env: [],
    gitRepos: [],
    resourceSkills: [],
  },
  updatedAt: NOW,
  updatedBy: "member-self",
};

// Usage tab sample data — crafted to exercise the slimmed Recent turns table:
// a long chat title (truncates), a non-default model (claude-haiku) next to the
// dominant one, and big token counts (compact in-cell, exact on hover).
const USAGE_SUMMARY: UsageAgentSummary = {
  agentId: UUID,
  from: "2026-05-23T00:00:00.000Z",
  to: NOW,
  totals: {
    inputTokens: 1_293_770,
    cachedInputTokens: 3_538_960,
    outputTokens: 236_600,
    turns: 3,
    chats: 3,
    lastUsageAt: NOW,
  },
  daily: [
    { date: "2026-06-02", inputTokens: 121_730, cachedInputTokens: 656_880, outputTokens: 38_460, turns: 1 },
    { date: "2026-06-03", inputTokens: 1_100_000, cachedInputTokens: 2_880_000, outputTokens: 187_500, turns: 1 },
    { date: "2026-06-04", inputTokens: 72_040, cachedInputTokens: 2_080, outputTokens: 10_640, turns: 1 },
  ],
};

const USAGE_TURNS: UsageTurnsResponse = {
  agentId: UUID,
  from: "2026-05-23T00:00:00.000Z",
  to: NOW,
  rows: [
    {
      seq: 1,
      chatId: "chat-uxr",
      chatTitle: "Agent 详情页 UX 审查 — a deliberately long chat title that should truncate with an ellipsis",
      createdAt: NOW,
      inputTokens: 121_730,
      cachedInputTokens: 656_880,
      outputTokens: 38_460,
      provider: "claude-code",
      model: "claude-opus-4-8",
    },
    {
      seq: 2,
      chatId: "chat-launch",
      chatTitle: "Launch planning",
      createdAt: NOW,
      inputTokens: 1_100_000,
      cachedInputTokens: 2_880_000,
      outputTokens: 187_500,
      provider: "claude-code",
      model: "claude-opus-4-8",
    },
    {
      seq: 3,
      chatId: "chat-triage",
      chatTitle: "Quick triage",
      createdAt: NOW,
      inputTokens: 72_040,
      cachedInputTokens: 2_080,
      outputTokens: 10_640,
      provider: "claude-code",
      model: "claude-haiku-4-5",
    },
  ],
  nextCursor: null,
};

// The tabs only read uuid / agent / isHuman / canManageAgent / config / configLoading
// from the context. Building the full ~30-field shape adds no signal to the preview.
// (unavoidable cast: the omitted fields are never touched by these two tabs.)
const CTX = {
  uuid: UUID,
  agent: AGENT,
  isHuman: false,
  canManageAgent: true,
  canEditConfig: true,
  config: CONFIG,
  configLoading: false,
  navigateAway: () => undefined,
} as unknown as AgentDetailContext;

function buildClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY, gcTime: Number.POSITIVE_INFINITY },
    },
  });
  client.setQueryData(["agent-resources", UUID], RESOURCES);
  client.setQueryData(["usage-summary", UUID, "30d"], USAGE_SUMMARY);
  client.setQueryData(["usage-turns", UUID, "30d", 10], USAGE_TURNS);
  // Seed the agent switcher list (both admin/member keys, since preview auth is
  // ambient). fetchAllAgents flattens to Agent[].
  const switcherAgents: Agent[] = [
    AGENT,
    { ...AGENT, uuid: "agent-preview-2", name: "nova", displayName: "Nova", runtimeState: "working" },
    { ...AGENT, uuid: "agent-preview-3", name: "atlas", displayName: "Atlas Researcher", runtimeState: null },
  ];
  client.setQueryData(["agents", "team-page", "admin"], switcherAgents);
  client.setQueryData(["agents", "team-page", "member"], switcherAgents);
  return client;
}

// Provide the agent-detail outlet context without nesting a Router (react-router
// forbids a <Router> inside the app's Router). A descendant <Routes> matches the
// ambient location — the parent route is mounted at `/preview/agent-detail/*`.
function TabHost(props: { element: ReactNode }) {
  return (
    <Routes>
      <Route element={<Outlet context={CTX} />}>
        <Route index element={props.element} />
      </Route>
    </Routes>
  );
}

export function AgentDetailPreviewPage() {
  const client = buildClient();
  return (
    <QueryClientProvider client={client}>
      <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
        <div className="mx-auto" style={{ maxWidth: 720, padding: "var(--sp-6) var(--sp-4)" }}>
          <h1 className="text-title m-0" style={{ color: "var(--fg)" }}>
            Agent switcher (vertical B)
          </h1>
          <p className="text-body" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
            Replaces the breadcrumb: ‹ Team + avatar-over-name items, current agent selected (brand ring), presence
            dots. Switching is leave-guarded.
          </p>
          <div style={{ marginTop: "var(--sp-4)", marginBottom: "var(--sp-8)" }}>
            <AgentSwitcherStrip currentAgent={AGENT} currentTabPath="profile" onNavigate={() => {}} />
          </div>

          <h1 className="text-title m-0" style={{ color: "var(--fg)" }}>
            Environment tab — Repositories
          </h1>
          <p className="text-body" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
            Code repositories live on the Environment tab now (they're part of the workspace the agent runs in). Saved
            immediately.
          </p>
          <div style={{ marginTop: "var(--sp-4)", marginBottom: "var(--sp-8)" }}>
            <ResourceTypeSection type="repo" data={RESOURCES} canEdit pending={false} onMutate={() => {}} />
          </div>

          <h1 className="text-title m-0" style={{ color: "var(--fg)" }}>
            Tools &amp; skills tab
          </h1>
          <p className="text-body" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
            Skills / MCP — team-recommended rows carry an on/off Switch (off = greyed, stays in the list); opt-in /
            added rows have no Switch, just ⋯ Remove. Can't load flags a broken reference.
          </p>
          <div style={{ marginTop: "var(--sp-4)", marginBottom: "var(--sp-8)" }}>
            <TabHost element={<ResourcesTab />} />
          </div>

          <h1 className="text-title m-0" style={{ color: "var(--fg)" }}>
            Instructions tab
          </h1>
          <p className="text-body" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
            Result-first: the top block shows the merged runtime instructions (clamp + Show all), without extra label
            copy. Source rows are de-crowded — Switch + ⋯ only, click a row to read its full body.
          </p>
          <div style={{ marginTop: "var(--sp-4)" }}>
            <TabHost element={<PromptTab />} />
          </div>

          <h1 className="text-title m-0" style={{ marginTop: "var(--sp-8)", color: "var(--fg)" }}>
            Usage tab — Recent turns
          </h1>
          <p className="text-body" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
            Slimmed: model name only (provider on hover), Chat truncates with a tooltip, token columns compact with the
            exact value on hover, window in the title.
          </p>
          <div style={{ marginTop: "var(--sp-4)" }}>
            <TabHost element={<UsageTab fetchEnabled={false} refetchInterval={false} />} />
          </div>

          <h1 className="text-title m-0" style={{ marginTop: "var(--sp-8)", color: "var(--fg)" }}>
            Execution
          </h1>
          <p className="text-body" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
            Runtime row is label:value; the bound Computer row shows the computer name only — live presence lives in the
            page header, so it is not repeated here.
          </p>
          <div style={{ marginTop: "var(--sp-4)" }}>
            <RuntimeSection runtimeProvider="claude-code" computerLabel="gandy-macbook" canBindComputer={false} />
          </div>
        </div>
        <button
          type="button"
          className="fixed text-caption mono"
          onClick={() => document.documentElement.classList.toggle("dark")}
          style={{
            bottom: "var(--sp-4)",
            left: "var(--sp-4)",
            padding: "var(--sp-1) var(--sp-2_5)",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-input)",
            background: "var(--bg-raised)",
            color: "var(--fg-2)",
            cursor: "pointer",
            boxShadow: "var(--shadow-md)",
          }}
        >
          theme
        </button>
      </div>
    </QueryClientProvider>
  );
}
