import { Navigate } from "react-router";
import { useAgentDetailContext } from "./layout-context.js";
import { PromptSection } from "./prompt-section.js";
import { sectionAnchorId } from "./save-bar.js";

export function PromptTab() {
  const ctx = useAgentDetailContext();
  // Hidden from buildTabs for non-config-editable agents; redirect stale
  // deep links to Profile so we don't render a blank page.
  if (!ctx.canEditConfig) return <Navigate to="../profile" replace />;
  if (!ctx.config) return null;
  return (
    <div id={sectionAnchorId("prompt")}>
      <PromptSection
        value={ctx.draft.draft.promptAppend}
        baseline={ctx.config.payload.prompt.append ?? ""}
        onChange={ctx.draft.setPromptAppend}
        onRevert={ctx.draft.revertPrompt}
        disabled={ctx.agent.status !== "active"}
      />
    </div>
  );
}
