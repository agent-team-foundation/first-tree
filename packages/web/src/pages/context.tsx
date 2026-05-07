import { PageHeader } from "../components/ui/page-header.js";
import { Panel } from "../components/ui/panel.js";

/**
 * Context-tree home. Placeholder for the user-facing tree visualization
 * (tracked separately). The eventual view will let users perceive how the
 * context-tree is being updated and iterated over time.
 */
export function ContextPage() {
  return (
    <div className="-m-6">
      <PageHeader title="Context" subtitle="The team's living source of truth" />
      <div style={{ padding: "var(--sp-4) var(--sp-5) var(--sp-7)" }}>
        <Panel>
          <div
            className="text-body"
            style={{ padding: "var(--sp-6) var(--sp-5)", color: "var(--fg-3)", textAlign: "center" }}
          >
            Tree visualization is on the way. This view will surface structure, relationships, and recent changes to the
            context-tree at a glance.
          </div>
        </Panel>
      </div>
    </div>
  );
}
