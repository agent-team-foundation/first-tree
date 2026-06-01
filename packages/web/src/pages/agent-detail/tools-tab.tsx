import { Navigate } from "react-router";
import { Section } from "../../components/ui/section.js";
import { useAgentDetailContext } from "./layout-context.js";
import { sectionAnchorId } from "./save-bar.js";

export function ToolsTab() {
  const ctx = useAgentDetailContext();

  // Hidden from buildTabs for non-config-editable agents; redirect stale
  // deep links to Profile so we don't render a blank page.
  if (!ctx.canEditConfig) return <Navigate to="../profile" replace />;
  if (!ctx.config) return null;
  return (
    <div id={sectionAnchorId("mcp")}>
      <Section
        title="MCP servers"
        count={ctx.draft.draft.mcp.filter((item) => item.status !== "deleted").length}
        description="Legacy per-agent MCP editing is disabled. Team MCP Resources will manage MCP configuration."
      >
        {ctx.draft.draft.mcp.length === 0 ? (
          <p className="text-body text-muted-foreground" style={{ padding: "var(--sp-3) 0" }}>
            No MCP servers are configured.
          </p>
        ) : (
          <div className="space-y-2" style={{ padding: "var(--sp-3) 0" }}>
            {ctx.draft.draft.mcp
              .filter((item) => item.status !== "deleted")
              .map((item) => (
                <div key={item.key} className="flex min-w-0 items-center gap-2 text-body">
                  <span className="text-caption rounded bg-muted px-1.5 py-0.5 font-mono shrink-0">
                    {item.value.transport}
                  </span>
                  <span className="font-medium font-mono shrink-0">{item.value.name}</span>
                </div>
              ))}
          </div>
        )}
      </Section>
    </div>
  );
}
