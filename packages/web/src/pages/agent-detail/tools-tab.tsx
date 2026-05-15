import { useMemo } from "react";
import { useAgentDetailContext } from "./layout-context.js";
import { McpSection } from "./mcp-section.js";
import { sectionAnchorId } from "./save-bar.js";

export function ToolsTab() {
  const ctx = useAgentDetailContext();
  const otherNames = useMemo(() => {
    const active = ctx.draft.draft.mcp.filter((i) => i.status !== "deleted");
    return (exceptKey: string | null): ReadonlySet<string> =>
      new Set(active.filter((i) => i.key !== exceptKey).map((i) => i.value.name.toLowerCase()));
  }, [ctx.draft.draft.mcp]);

  if (!ctx.canEditConfig || !ctx.config) return null;
  return (
    <div id={sectionAnchorId("mcp")}>
      <McpSection
        items={ctx.draft.draft.mcp}
        otherNames={otherNames}
        onAdd={ctx.draft.addMcp}
        onUpdate={ctx.draft.updateMcp}
        onDelete={ctx.draft.deleteMcp}
        onUndoDelete={ctx.draft.undoDeleteMcp}
        disabled={ctx.agent.status !== "active"}
      />
    </div>
  );
}
