import { FirstTreeLogo } from "../components/first-tree-logo.js";
import { ContextPage } from "./context.js";
import { MOCK_CONTEXT_SNAPSHOT } from "./context-preview-mock.js";

const PREVIEW_NAV_TABS = [
  { label: "Workspace", active: false },
  { label: "Context", active: true },
  { label: "Team", active: false },
  { label: "Settings", active: false },
];

/**
 * Public preview route. The real `/context` route lives inside <Layout>, which
 * provides the top nav bar and centres pages inside a max-width content
 * container with `p-6` padding. The preview is mounted *outside* <Layout>
 * (no auth, no React Router context), so we mirror the visual shell here:
 *
 *  - PreviewHeader  — static, non-interactive copy of the Layout top bar so
 *                     the preview matches production framing.
 *  - main wrapper   — same `p-6 max-w-[960] mx-auto` content geometry as
 *                     Layout, so width/padding stay aligned with the Team tab
 *                     (960 is the shared content canvas; the old 1280 here
 *                     overstated the real width).
 *
 * The header is presentational only — none of its buttons / tabs do anything.
 * That's intentional: this route is for visual review, not navigation.
 */
export function ContextPreviewPage() {
  return (
    <div className="flex flex-col overflow-hidden" style={{ height: "100vh", background: "var(--bg)" }}>
      <PreviewHeader />
      <main className="flex-1 overflow-auto">
        <div className="p-4 lg:p-6 mx-auto" style={{ maxWidth: 960 }}>
          <ContextPage previewSnapshot={MOCK_CONTEXT_SNAPSHOT} />
        </div>
      </main>
    </div>
  );
}

function PreviewHeader() {
  return (
    <header
      className="relative shrink-0 grid items-center"
      style={{
        height: 48,
        gridTemplateColumns: "1fr auto 1fr",
        gap: "var(--sp-3)",
        padding: "0 var(--sp-3)",
        borderBottom: "var(--hairline) solid var(--border)",
        background: "var(--bg-raised)",
      }}
    >
      <div className="flex items-center" style={{ gap: "var(--sp-3_5)", justifySelf: "start", minWidth: 0 }}>
        <span className="flex items-center" style={{ gap: 10, flexShrink: 0 }}>
          <FirstTreeLogo width={16} height={18} style={{ color: "var(--fg)" }} />
          <span className="text-title" style={{ color: "var(--fg)" }}>
            First Tree
          </span>
        </span>
      </div>
      <nav className="flex" style={{ gap: 2, justifySelf: "center" }}>
        {PREVIEW_NAV_TABS.map((tab) => (
          <span
            key={tab.label}
            className="inline-flex items-center text-subtitle font-medium"
            style={{
              padding: "var(--sp-1_5) var(--sp-3)",
              gap: 6,
              borderRadius: 5,
              color: tab.active ? "var(--fg)" : "var(--fg-3)",
              background: tab.active ? "var(--bg-hover)" : "transparent",
            }}
          >
            {tab.label}
          </span>
        ))}
      </nav>
      <div style={{ justifySelf: "end" }} />
    </header>
  );
}
