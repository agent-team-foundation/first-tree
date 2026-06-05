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
    // A deliberately long URL so the row truncation + hover tooltip is testable.
    payload: { url: "git@github.com:agent-team-foundation/first-tree-monorepo-with-a-very-long-name.git" },
  }),
  row({
    id: "r2",
    type: "repo",
    name: "context-tree",
    payload: { url: "git@github.com:agent-team-foundation/context-tree.git", defaultBranch: "main" },
  }),
  row({
    id: "r3",
    type: "prompt",
    name: "Code review checklist",
    defaultEnabled: "recommended",
    payload: {
      description: "House rules for reviewing a diff before approval.",
      body: "# Code review checklist\n\n- **Correctness** — does it do what the PR says?\n- **Tests** — new behaviour covered, edge cases included.\n- **Security** — no secrets, no SQL string-building, trust boundaries respected.\n- **Style** — tokens not raw values, no `any`, no `as` without a reason.\n\nApprove only when every box is honestly ticked.",
    },
  }),
  row({
    id: "r4",
    type: "prompt",
    // No description → list summary falls back to a stripped body snippet
    // (instead of the old meaningless "N chars").
    name: "Tone guide",
    payload: {
      body: "Write plainly and directly. Prefer short sentences. Avoid filler like *very*, *really*, *just*. Lead with the conclusion, then the reasoning.",
    },
  }),
  row({
    id: "r5",
    type: "skill",
    name: "release-notes",
    payload: {
      name: "release-notes",
      namespace: "team",
      description: "Draft release notes from a merged PR range.",
      body: "## release-notes\n\nGiven a PR range, group merged PRs into **Features / Fixes / Chores** and write a one-line human summary for each. Link every entry to its PR.",
      metadata: { category: "writing" },
    },
  }),
  row({
    id: "r5b",
    type: "skill",
    name: "frontend design system",
    defaultEnabled: "recommended",
    // A real-world long body that opens with a document-level H1 and several H2
    // sections — the case that motivated the preview-dialog heading clamp +
    // internal-scroll work. Lets the preview show the fixed header / scrolling
    // body split with headings that no longer dwarf the dialog title.
    payload: {
      name: "frontend design system",
      namespace: "team",
      description:
        "Use when changing any frontend code in packages/web — editing .tsx, .css, or Tailwind classes, or adjusting colors, spacing, sizing, radius, shadows, or font-size.",
      body: [
        "# Frontend Design System (packages/web)",
        "",
        "## Core principle",
        "",
        "packages/web is a token-based design system: every visual value comes from a CSS variable defined in `packages/web/src/index.css` — never a literal. `lint:tokens` is a build gate; hardcoded values fail the build. Read `packages/web/DESIGN.md` before writing any UI code, and follow it exactly.",
        "",
        "## Hard constraints (non-negotiable)",
        "",
        "- **No hardcoded visual values.** Never inline a color, size, spacing, radius, shadow, or font-size — every value references a token in `index.css`. If the token you need doesn't exist, add it; do not inline the literal.",
        "- **Use the semantic layer only.** Use `--fg`, `--bg-*`, `--state-*`, the `text-*` scale, `--radius-*`. Do not use raw Tailwind palette/size utilities (`text-gray-500`, `bg-red-50`, `rounded-md`).",
        "- **New base components** go in `src/components/ui/`, composed with `cva` + `cn` + Radix.",
        "",
        "## Before you claim done",
        "",
        "Run `pnpm --filter @first-tree/web typecheck` (runs `tsc` + the `lint:tokens` gate) and confirm it passes. A token violation fails the build — green is the only definition of done.",
        "",
        "## Common rationalizations — all wrong",
        "",
        "| Excuse | Reality |",
        "|--------|---------|",
        "| \"Just one literal, I'll tokenize later\" | `lint:tokens` fails the build now. Add the token now. |",
        "| \"There's no token for this value\" | Add one to `index.css`. That's the workflow, not an exception. |",
        "| \"`text-gray-500` is close enough\" | Raw palette utilities are banned. Use the semantic token. |",
      ].join("\n"),
      metadata: { category: "frontend", scope: "packages/web" },
    },
  }),
  row({
    id: "r6",
    type: "mcp",
    name: "github",
    defaultEnabled: "recommended",
    payload: { name: "github", transport: "http", url: "https://mcp.example.com/github" },
  }),
  row({
    id: "r7",
    type: "mcp",
    name: "local-tools",
    payload: { name: "local-tools", transport: "stdio", command: "npx", args: ["-y", "@team/mcp-tools", "--verbose"] },
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
