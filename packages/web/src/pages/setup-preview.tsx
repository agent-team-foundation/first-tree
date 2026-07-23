import { Link, useSearchParams } from "react-router";
import { AuthContext } from "../auth/auth-context.js";
import { cn } from "../lib/utils.js";
import { buildSetupRows, type SetupFacts, SetupOverview } from "./settings/setup.js";
import { SettingsLayout } from "./settings.js";

type PreviewRole = "admin" | "member";

function previewFacts(role: PreviewRole): SetupFacts {
  if (role === "member") {
    return {
      role,
      teamName: "Gandy's team",
      hasUsableAgent: true,
      hasPersonalAgent: false,
      onboardingSuppressedAt: "2026-07-23T00:00:00.000Z",
      onboardingCompletedAt: null,
      workspaceWillEnterOnboarding: false,
      computers: {
        state: "ready",
        value: { connected: 0, saved: 0, connectedHostname: null },
      },
      repositories: { state: "ready", value: 3 },
      contextTree: {
        state: "ready",
        value: {
          bound: true,
          repo: "https://github.com/agent-team-foundation/first-tree-context",
          branch: "main",
          availability: "active",
        },
      },
      github: {
        state: "ready",
        value: {
          accountLogin: "agent-team-foundation",
          accountType: "Organization",
          suspended: false,
        },
      },
      gitlab: { state: "ready", value: null },
    };
  }

  return {
    role,
    teamName: "Gandy's team",
    hasUsableAgent: true,
    hasPersonalAgent: true,
    onboardingSuppressedAt: "2026-07-23T00:00:00.000Z",
    onboardingCompletedAt: "2026-07-23T00:00:00.000Z",
    workspaceWillEnterOnboarding: false,
    computers: {
      state: "ready",
      value: { connected: 1, saved: 1, connectedHostname: "Gandy-MacBook-Pro" },
    },
    repositories: { state: "ready", value: 3 },
    contextTree: {
      state: "ready",
      value: {
        bound: true,
        repo: "https://github.com/agent-team-foundation/first-tree-context",
        branch: "main",
        availability: "active",
      },
    },
    github: {
      state: "ready",
      value: {
        accountLogin: "agent-team-foundation",
        accountType: "Organization",
        suspended: false,
      },
    },
    gitlab: { state: "ready", value: null },
  };
}

export function SetupPreviewPage() {
  const [searchParams] = useSearchParams();
  const role: PreviewRole = searchParams.get("role") === "member" ? "member" : "admin";
  const facts = previewFacts(role);
  const auth = {
    isAuthenticated: true,
    meLoaded: true,
    role,
    organizationId: "org-preview",
    teamDisplayName: facts.teamName,
    currentOrgHasUsableAgent: facts.hasUsableAgent,
    currentOrgHasPersonalAgent: facts.hasPersonalAgent,
  } as unknown as Parameters<typeof AuthContext.Provider>[0]["value"];

  return (
    <AuthContext.Provider value={auth}>
      <div style={{ minHeight: "100vh", background: "var(--bg)" }} data-setup-preview={role}>
        <SettingsLayout activePathname="/settings/setup">
          <SetupOverview facts={facts} rows={buildSetupRows(facts)} />
        </SettingsLayout>
        <nav
          aria-label="Setup preview role"
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
              to={`/preview/setup?role=${candidate}`}
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
              }}
            >
              {candidate === "admin" ? "Admin" : "Member"}
            </Link>
          ))}
        </nav>
      </div>
    </AuthContext.Provider>
  );
}
