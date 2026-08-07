import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { setupCapabilitiesQueryKey } from "../api/setup-capabilities.js";
import { AuthContext } from "../auth/auth-context.js";
import { cn } from "../lib/utils.js";
import { SettingsContextTreePage } from "./settings/context-tree.js";
import { SettingsLayout } from "./settings.js";
import { PREVIEW_CAPABILITIES } from "./setup-preview.js";

type PreviewRole = "admin" | "member";

const ORGANIZATION_ID = "org-preview";
const PREVIEW_SETUP_PROMPT = `Connect this coding agent to Gandy's team Context Tree.

Use First Tree to read the applicable Team context before acting, then continue the current task.`;

export function SettingsContextTreePreviewPage() {
  const [searchParams] = useSearchParams();
  const role: PreviewRole = searchParams.get("role") === "member" ? "member" : "admin";
  const queryClient = useMemo(() => createPreviewQueryClient(), []);
  const auth = {
    isAuthenticated: true,
    meLoaded: true,
    role,
    organizationId: ORGANIZATION_ID,
    teamDisplayName: "Gandy's team",
    currentOrgHasUsableAgent: true,
    currentOrgHasPersonalAgent: true,
    onboardingDismissedAt: null,
    onboardingCompletedAt: "2026-07-23T00:00:00.000Z",
  } as unknown as Parameters<typeof AuthContext.Provider>[0]["value"];

  return (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <div data-settings-context-tree-preview={role} style={{ minHeight: "100vh", background: "var(--bg)" }}>
          <SettingsLayout activePathname="/settings/context">
            <SettingsContextTreePage preparePrompt={async () => PREVIEW_SETUP_PROMPT} />
          </SettingsLayout>
          <nav
            aria-label="Context Tree settings preview controls"
            className="fixed flex"
            style={{
              right: "var(--sp-4)",
              bottom: "var(--sp-4)",
              gap: "var(--sp-1)",
              padding: "var(--sp-1)",
              border: "var(--hairline) solid var(--border)",
              borderRadius: "var(--radius-input)",
              background: "var(--bg-raised)",
              boxShadow: "var(--shadow-md)",
            }}
          >
            {(["admin", "member"] as const).map((candidate) => (
              <Link
                key={candidate}
                to={`/preview/settings-context-tree?role=${candidate}`}
                aria-current={role === candidate ? "page" : undefined}
                className={cn(
                  "text-label font-medium",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                )}
                style={{
                  padding: "var(--sp-1_5) var(--sp-3)",
                  borderRadius: "var(--radius-input)",
                  color: role === candidate ? "var(--fg)" : "var(--fg-3)",
                  background: role === candidate ? "var(--bg-hover)" : "transparent",
                  textDecoration: "none",
                  textTransform: "capitalize",
                }}
              >
                {candidate}
              </Link>
            ))}
          </nav>
        </div>
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}

function createPreviewQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
      },
    },
  });
  client.setQueryData(setupCapabilitiesQueryKey(ORGANIZATION_ID), PREVIEW_CAPABILITIES);
  client.setQueryData(["context-tree-snapshot", ORGANIZATION_ID, "7d", false], {
    snapshotStatus: "active",
    contextStatus: { severity: "ok", label: "Available", detail: null },
  });
  client.setQueryData(
    ["settings", "context-tree", "team-resources", ORGANIZATION_ID],
    [{ type: "repo", status: "active" }],
  );
  client.setQueryData(["org-setting", ORGANIZATION_ID, "context_tree", "raw"], {
    repo: "https://github.com/agent-team-foundation/first-tree-context",
    branch: "main",
    provider: "github",
  });
  client.setQueryData(["context-reviewer", "candidates", ORGANIZATION_ID], {
    items: [
      {
        uuid: "agent-reviewer",
        name: "context-reviewer",
        displayName: "Context Reviewer",
        visibility: "organization",
        runtime: { health: "ready", blockers: [] },
      },
    ],
    blockers: [],
  });
  return client;
}
