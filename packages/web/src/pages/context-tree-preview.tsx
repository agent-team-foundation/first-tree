import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ContextType, useMemo } from "react";
import { Route, Routes } from "react-router";
import { AuthContext } from "../auth/auth-context.js";
import { PageHeader } from "../components/ui/page-header.js";
import { ContextTreeBuildEntry } from "./context-tree-build-entry.js";
import { SettingsRepositoriesPage } from "./settings/repositories.js";
import { SettingsLayout } from "./settings.js";

/**
 * DEV-only visual preview for the chat-first Context setup. Renders the REAL
 * full Settings → Repositories page (sidebar + header + both repo models) in each state,
 * plus the Context tab's single build entry. Mounted with a seeded React Query
 * cache + a mock AuthContext so the real components render with no backend.
 * Visual review only — buttons hit dead mocks.
 */

const ORG = "org-preview";

// Minimal DEV mock rows — only the fields the previewed components actually read.
const AGENTS = [
  {
    uuid: "0192aaaa-bot1",
    displayName: "acme-assistant",
    name: "acme-assistant",
    type: "agent",
    status: "active",
    organizationId: ORG,
  },
  {
    uuid: "0192bbbb-bot2",
    displayName: "acme-reviewer",
    name: "acme-reviewer",
    type: "agent",
    status: "active",
    organizationId: ORG,
  },
];
const FEATURES_DISABLED = { contextReviewer: { enabled: false, agentUuid: null } };
const FEATURES_ENABLED = { contextReviewer: { enabled: true, agentUuid: "0192bbbb-bot2" } };
// Enabled, but the saved reviewer is no longer one of the admin's active agents.
const FEATURES_ENABLED_MISSING = { contextReviewer: { enabled: true, agentUuid: "0192ffff-gone" } };
const BOUND = { repo: "https://github.com/acme/acme-context", branch: "main" };
const UNBOUND = { repo: null, branch: null };
const CODE_REPOSITORIES = [
  {
    id: "repo-web",
    organizationId: ORG,
    type: "repo",
    scope: "team",
    ownerAgentId: null,
    name: "first-tree",
    repoCanonicalKey: "github.com/acme/first-tree",
    defaultEnabled: "recommended",
    status: "active",
    payload: { url: "https://github.com/acme/first-tree.git", defaultBranch: "main" },
    createdBy: "member-preview",
    updatedBy: "member-preview",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
  },
];
const GITHUB_APP_READY = {
  installationId: 42,
  accountLogin: "acme",
  accountType: "Organization",
  accountGithubId: 42,
  repositorySelection: "selected",
  permissions: { metadata: "read", pull_requests: "write" },
  events: ["pull_request"],
  suspended: false,
  manageUrl: "https://github.com/organizations/acme/settings/installations/42",
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
};
const REVIEWER_AGENTS_KEY = ["context-reviewer", "org-agents", ORG] as const;

type Seed = ReadonlyArray<readonly [readonly unknown[], unknown]>;

function useSeededClient(seed: Seed): QueryClient {
  return useMemo(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { staleTime: Number.POSITIVE_INFINITY, gcTime: Number.POSITIVE_INFINITY, retry: false },
      },
    });
    for (const [key, data] of seed) client.setQueryData([...key], data);
    return client;
  }, [seed]);
}

function mockAuth(role: string, onboardingCompletedAt: string | null): ContextType<typeof AuthContext> {
  return { role, organizationId: ORG, onboardingCompletedAt, meLoaded: true } as unknown as ContextType<
    typeof AuthContext
  >;
}

/** The REAL Settings → Repositories page (sidebar + header + panels) for one state. */
function FullPageCase({ title, authRole, seed }: { title: string; authRole: string; seed: Seed }) {
  const qc = useSeededClient(seed);
  const auth = mockAuth(authRole, "2026-01-01T00:00:00.000Z");
  return (
    <div style={{ marginBottom: "var(--sp-6)" }}>
      <div className="text-eyebrow" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-2)" }}>
        {title}
      </div>
      <div
        style={{
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-panel)",
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <QueryClientProvider client={qc}>
          <AuthContext.Provider value={auth}>
            <Routes>
              <Route element={<SettingsLayout activePathname="/settings/repositories" />}>
                <Route path="*" element={<SettingsRepositoriesPage />} />
              </Route>
            </Routes>
          </AuthContext.Provider>
        </QueryClientProvider>
      </div>
    </div>
  );
}

/** The Context tab build entry on its own (it lives in the Context tab empty state). */
function BuildEntryCase({
  title,
  seed,
  intent = "build",
}: {
  title: string;
  seed: Seed;
  intent?: "build" | "recover";
}) {
  const qc = useSeededClient(seed);
  const auth = mockAuth("admin", "2026-01-01T00:00:00.000Z");
  return (
    <section
      style={{
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-panel)",
        padding: "var(--sp-4)",
        background: "var(--bg-raised)",
      }}
    >
      <div className="text-eyebrow" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-3)" }}>
        {title}
      </div>
      <QueryClientProvider client={qc}>
        <AuthContext.Provider value={auth}>
          <ContextTreeBuildEntry intent={intent} />
        </AuthContext.Provider>
      </QueryClientProvider>
    </section>
  );
}

export function ContextTreePreviewPage() {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", padding: "var(--sp-6)" }}>
      <PageHeader title="Repositories — preview" subtitle="DEV-only visual review of repository settings." />

      <div style={{ marginTop: "var(--sp-5)" }}>
        <FullPageCase
          title="Settings → Repositories · admin, team HAS a tree"
          authRole="admin"
          seed={[
            [["team-resources"], CODE_REPOSITORIES],
            [["org-setting", ORG, "context_tree", "raw"], BOUND],
            [["org-setting", ORG, "context_tree_features"], FEATURES_DISABLED],
            [["github-app-installation", ORG], GITHUB_APP_READY],
          ]}
        />
        <FullPageCase
          title="Settings → Repositories · admin, no Context Tree yet"
          authRole="admin"
          seed={[
            [["team-resources"], CODE_REPOSITORIES],
            [["org-setting", ORG, "context_tree", "raw"], UNBOUND],
            [["org-setting", ORG, "context_tree_features"], FEATURES_DISABLED],
          ]}
        />
        <FullPageCase
          title="Settings → Repositories · member (read-only)"
          authRole="member"
          seed={[
            [["team-resources"], CODE_REPOSITORIES],
            [["org-setting", ORG, "context_tree", "safe"], BOUND],
            [["org-setting", ORG, "context_tree_features"], FEATURES_DISABLED],
            [["github-app-installation", ORG], GITHUB_APP_READY],
          ]}
        />
      </div>

      <div className="text-eyebrow" style={{ color: "var(--fg-3)", margin: "var(--sp-4) 0 var(--sp-3)" }}>
        Automatic PR review · immediate-save Switch. Toggle on/off to see setup ↔ saved.
      </div>
      <div style={{ marginTop: "var(--sp-2)" }}>
        <FullPageCase
          title="Automatic PR review · OFF (flip the Switch on → choose a reviewer)"
          authRole="admin"
          seed={[
            [["team-resources"], CODE_REPOSITORIES],
            [["org-setting", ORG, "context_tree", "raw"], BOUND],
            [["org-setting", ORG, "context_tree_features"], FEATURES_DISABLED],
            [["github-app-installation", ORG], GITHUB_APP_READY],
            [REVIEWER_AGENTS_KEY, AGENTS],
          ]}
        />
        <FullPageCase
          title="Automatic PR review · ON with a selected reviewer"
          authRole="admin"
          seed={[
            [["team-resources"], CODE_REPOSITORIES],
            [["org-setting", ORG, "context_tree", "raw"], BOUND],
            [["org-setting", ORG, "context_tree_features"], FEATURES_ENABLED],
            [["github-app-installation", ORG], GITHUB_APP_READY],
            [REVIEWER_AGENTS_KEY, AGENTS],
          ]}
        />
        <FullPageCase
          title="Automatic PR review · saved reviewer unavailable"
          authRole="admin"
          seed={[
            [["team-resources"], CODE_REPOSITORIES],
            [["org-setting", ORG, "context_tree", "raw"], BOUND],
            [["org-setting", ORG, "context_tree_features"], FEATURES_ENABLED_MISSING],
            [["github-app-installation", ORG], GITHUB_APP_READY],
            [REVIEWER_AGENTS_KEY, AGENTS],
          ]}
        />
      </div>

      <div className="text-eyebrow" style={{ color: "var(--fg-3)", margin: "var(--sp-4) 0 var(--sp-3)" }}>
        Context tab build entry (lives on the Context tab empty state, not Settings)
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 24rem), 1fr))",
          gap: "var(--sp-5)",
        }}
      >
        <BuildEntryCase title="build · 2 agents" seed={[[["context-build", "managed-agents", ORG], AGENTS]]} />
        <BuildEntryCase
          title="bound tree recovery · continue in chat"
          intent="recover"
          seed={[[["context-build", "managed-agents", ORG], AGENTS]]}
        />
        <BuildEntryCase title="build · no active agent" seed={[[["context-build", "managed-agents", ORG], []]]} />
      </div>
    </div>
  );
}
