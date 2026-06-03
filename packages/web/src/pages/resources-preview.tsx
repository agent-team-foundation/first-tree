import type { ResourceRow } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthContext } from "../auth/auth-context.js";
import { SettingsResourcesPage } from "./settings/resources.js";

/**
 * DEV-only visual preview of the redesigned Settings → Resources page, mounted
 * at `/preview/resources` (gated by `import.meta.env.DEV` in app.tsx).
 *
 * Unlike the standalone mock previews (e.g. /preview/team), this renders the
 * REAL `SettingsResourcesPage` component so the screenshot is faithful to what
 * ships — including the rebuilt create dialog (design-system Select / Textarea)
 * and the list-row Badges. It just supplies two things a backend would
 * normally provide:
 *   - a nested QueryClient pre-seeded with sample resources (so the list
 *     renders without a network call), and
 *   - an admin auth membership (so the create / retire affordances show).
 *
 * No backend, no auth round-trip. Submitting the dialog would hit the real API
 * and fail — this page is for looking, not for round-tripping.
 */

const NOW = "2026-06-03T00:00:00.000Z";

function row(over: Partial<ResourceRow> & Pick<ResourceRow, "id" | "type" | "name" | "payload">): ResourceRow {
  return {
    organizationId: "org-preview",
    scope: "team",
    ownerAgentId: null,
    repoCanonicalKey: null,
    defaultEnabled: "available",
    status: "active",
    createdBy: "preview",
    updatedBy: "preview",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const SAMPLE: ResourceRow[] = [
  row({
    id: "r1",
    type: "repo",
    name: "first-tree",
    defaultEnabled: "recommended",
    payload: { url: "git@github.com:agent-team-foundation/first-tree.git" },
  }),
  row({
    id: "r2",
    type: "repo",
    name: "context-tree",
    payload: { url: "git@github.com:agent-team-foundation/context-tree.git" },
  }),
  row({
    id: "r3",
    type: "prompt",
    name: "Code review checklist",
    defaultEnabled: "recommended",
    payload: { description: "House rules for reviewing a diff before approval." },
  }),
  row({
    id: "r4",
    type: "skill",
    name: "release-notes",
    payload: { description: "Draft release notes from a merged PR range." },
  }),
  row({
    id: "r5",
    type: "mcp",
    name: "github",
    defaultEnabled: "recommended",
    payload: { name: "github", transport: "http", url: "https://mcp.example.com/github" },
  }),
];

function buildClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY, gcTime: Number.POSITIVE_INFINITY },
    },
  });
  client.setQueryData(["team-resources"], SAMPLE);
  return client;
}

// Minimal admin membership — `SettingsResourcesPage` only reads `role`. The
// rest of the context shape is irrelevant to this page, so it is faked.
// (unavoidable cast: building the full 20-field auth value adds no signal.)
const ADMIN_AUTH = {
  isAuthenticated: true,
  meLoaded: true,
  role: "admin",
  organizationId: "org-preview",
} as unknown as Parameters<typeof AuthContext.Provider>[0]["value"];

export function ResourcesPreviewPage() {
  const client = buildClient();
  return (
    <QueryClientProvider client={client}>
      <AuthContext.Provider value={ADMIN_AUTH}>
        <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
          <div className="mx-auto" style={{ maxWidth: 960 }}>
            <SettingsResourcesPage />
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
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}
