import { Button } from "../../components/ui/button.js";
import type { DraftSectionName, DraftSummary } from "./use-config-draft.js";

/**
 * Redesign §5.7 Save Bar — sticky-bottom, page-scoped, Behavior-only.
 * Identity edits bypass it entirely (they go through the identity API).
 */

export type SaveBarProps = {
  summary: DraftSummary;
  saveHint: string;
  conflictMessage: string | null;
  errorMessage: string | null;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onReloadRemote: () => void;
  onJumpTo: (section: DraftSectionName) => void;
};

const SECTION_LABELS: Record<DraftSectionName, string> = {
  prompt: "Prompt",
  model: "Model",
  mcp: "MCP",
  env: "Env",
  git: "Git",
};

export function SaveBar(props: SaveBarProps) {
  if (!props.summary.anyDirty && !props.conflictMessage && !props.errorMessage) return null;

  return (
    <div className="sticky bottom-0 z-30 -mx-6 border-t bg-yellow-50/95 px-6 py-3 backdrop-blur">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-1 text-sm">
          {props.summary.anyDirty && (
            <div className="flex items-center gap-2">
              <span aria-hidden>🟡</span>
              <span className="font-medium">
                {props.summary.dirtySections.length} section
                {props.summary.dirtySections.length === 1 ? "" : "s"} with unsaved changes
              </span>
              <span className="text-muted-foreground">·</span>
              <span className="flex flex-wrap gap-1">
                {props.summary.dirtySections.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="rounded bg-white px-2 py-0.5 text-xs border hover:bg-amber-100"
                    onClick={() => props.onJumpTo(s)}
                  >
                    {SECTION_LABELS[s]}
                  </button>
                ))}
              </span>
            </div>
          )}
          <p className="text-xs text-muted-foreground">{props.saveHint}</p>
          {props.conflictMessage && <p className="text-xs text-amber-900 font-medium">{props.conflictMessage}</p>}
          {props.errorMessage && <p className="text-xs text-red-800 font-medium">{props.errorMessage}</p>}
        </div>
        <div className="flex gap-2">
          {props.conflictMessage && (
            <Button variant="outline" size="sm" onClick={props.onReloadRemote}>
              Discard mine, load latest
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={props.onDiscard} disabled={props.saving}>
            Discard changes
          </Button>
          <Button size="sm" onClick={props.onSave} disabled={props.saving || !props.summary.anyDirty}>
            {props.saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function sectionAnchorId(section: DraftSectionName): string {
  return `agent-cfg-${section}`;
}

export function dirtySummaryLabel(summary: DraftSummary): string {
  if (!summary.anyDirty) return "";
  return summary.dirtySections.map((s) => SECTION_LABELS[s]).join(" · ");
}
