import type { Agent, AgentResourcesOutput, AgentRuntimeConfig } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Outlet, Route, Routes } from "react-router";
import type { AgentDetailContext } from "./agent-detail/layout-context.js";
import { PromptTab } from "./agent-detail/prompt-tab.js";
import { ResourcesTab } from "./agent-detail/resources-tab.js";

/**
 * DEV-only visual preview of the redesigned agent-detail **Capabilities** and
 * **Prompt** tabs, mounted at `/preview/agent-detail` (gated by
 * `import.meta.env.DEV` in app.tsx).
 *
 * It renders the REAL `ResourcesTab` / `PromptTab` components, fed by a seeded
 * QueryClient + a mock outlet context — no backend, no auth. The sample data is
 * crafted so every label / marker / control is visible at once:
 *   - source labels: `From your team` vs `Added by you`
 *   - status markers: `Off`, `Overridden`, `Unavailable`, `Can't load`
 *   - controls: Customize / Disable / Edit / Remove / Re-enable / Enable
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
        promptBody: "Follow the team house style when reviewing diffs.",
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
  name: "kael",
  displayName: "Kael",
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
      append: "Follow the team house style when reviewing diffs.\n\nAlways summarize tradeoffs before recommending.",
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
} as unknown as AgentDetailContext;

function buildClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY, gcTime: Number.POSITIVE_INFINITY },
    },
  });
  client.setQueryData(["agent-resources", UUID], RESOURCES);
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
            Capabilities tab
          </h1>
          <p className="text-body" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
            Code repos / Skills / MCP — each row tagged From your team or Added by you; deviations show Off / Can't
            load.
          </p>
          <div style={{ marginTop: "var(--sp-4)", marginBottom: "var(--sp-8)" }}>
            <TabHost element={<ResourcesTab />} />
          </div>

          <h1 className="text-title m-0" style={{ color: "var(--fg)" }}>
            Instructions tab
          </h1>
          <p className="text-body" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
            Per-instruction management (Customize / Disable / Edit / Remove / Re-enable), optional team instructions to
            enable, and the read-only merged Effective instructions at the bottom.
          </p>
          <div style={{ marginTop: "var(--sp-4)" }}>
            <TabHost element={<PromptTab />} />
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
