import { useAgentDetailContext } from "./layout-context.js";
import { PromptSection } from "./prompt-section.js";
import { sectionAnchorId } from "./save-bar.js";

export function PromptTab() {
  const ctx = useAgentDetailContext();
  if (!ctx.canEditConfig || !ctx.config) return null;
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
