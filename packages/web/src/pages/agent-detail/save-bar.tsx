import { Check, Loader2 } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { StateDot } from "../../components/ui/state-dot.js";
import type { DraftSectionName, DraftSummary } from "./use-config-draft.js";

/**
 * Sticky-bottom save bar for the agent detail page. Behavior-only — identity
 * edits bypass it entirely (they go through the identity API).
 *
 * The bar is always tonally consistent with the rest of the page (mono / dense
 * / token-driven colors); no emoji, no warning-banner aesthetic. Section chips
 * use the same affordance as buttons elsewhere on the page.
 */

export type SaveBarProps = {
  summary: DraftSummary;
  saveHint: string;
  conflictMessage: string | null;
  errorMessage: string | null;
  saving: boolean;
  reloadingRemote?: boolean;
  /** Emits true for a short window after a successful save, so the bar can flash an inline check. */
  justSaved: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onReloadRemote: () => void;
  onJumpTo: (section: DraftSectionName) => void;
};

const SECTION_LABELS: Record<DraftSectionName, string> = {
  prompt: "Prompt",
  model: "Model",
  effort: "Reasoning effort",
  mcp: "MCP",
  env: "Env",
  git: "Git",
};

export function SaveBar(props: SaveBarProps) {
  if (!props.summary.anyDirty && !props.conflictMessage && !props.errorMessage && !props.justSaved) return null;

  const dirtyCount = props.summary.dirtySections.length;
  const showDraftActions = props.summary.anyDirty || props.saving;

  return (
    <div
      className="sticky bottom-0 z-30 -mx-6 backdrop-blur"
      style={{
        padding: "var(--sp-3) var(--sp-6)",
        background: "color-mix(in oklch, var(--bg-raised) 94%, transparent)",
        borderTop: "var(--hairline) solid var(--border)",
      }}
    >
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-1 text-body min-w-0">
          {props.summary.anyDirty && (
            <div className="flex items-center gap-2 flex-wrap">
              <StateDot state="blocked" size={8} />
              <span className="font-medium">
                {dirtyCount} section{dirtyCount === 1 ? "" : "s"} with unsaved changes
              </span>
              <span style={{ color: "var(--fg-4)" }} aria-hidden>
                ·
              </span>
              <span className="flex flex-wrap gap-1">
                {props.summary.dirtySections.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => props.onJumpTo(s)}
                    className="text-caption transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    style={{
                      padding: "var(--sp-0_5) var(--sp-1_5)",
                      borderRadius: "var(--radius-chip)",
                      background: "var(--bg-raised)",
                      border: "var(--hairline) solid var(--border)",
                      color: "var(--fg-2)",
                      cursor: "pointer",
                    }}
                  >
                    {SECTION_LABELS[s]}
                  </button>
                ))}
              </span>
            </div>
          )}
          {props.justSaved && !props.summary.anyDirty && !props.errorMessage && !props.conflictMessage && (
            <div className="inline-flex items-center gap-1.5 text-body font-medium" style={{ color: "var(--success)" }}>
              <Check className="h-3.5 w-3.5" />
              Saved
            </div>
          )}
          {props.saveHint && (
            <p className="text-caption" style={{ color: "var(--fg-3)" }}>
              {props.saveHint}
            </p>
          )}
          {props.conflictMessage && (
            <p className="text-caption font-medium" style={{ color: "var(--state-blocked)" }}>
              {props.conflictMessage}
            </p>
          )}
          {props.errorMessage && (
            <p className="text-caption font-medium" style={{ color: "var(--state-error)" }}>
              {props.errorMessage}
            </p>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          {props.conflictMessage && (
            <Button variant="outline" size="sm" onClick={props.onReloadRemote} disabled={!!props.reloadingRemote}>
              {props.reloadingRemote ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  Loading latest…
                </span>
              ) : (
                "Discard mine, load latest"
              )}
            </Button>
          )}
          {showDraftActions && (
            <>
              <Button variant="ghost" size="sm" onClick={props.onDiscard} disabled={props.saving}>
                Discard changes
              </Button>
              <Button size="sm" onClick={props.onSave} disabled={props.saving || !props.summary.anyDirty}>
                {props.saving ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    Saving…
                  </span>
                ) : (
                  "Save"
                )}
              </Button>
            </>
          )}
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
