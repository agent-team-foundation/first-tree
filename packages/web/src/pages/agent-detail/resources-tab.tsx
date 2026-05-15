import { useMemo } from "react";
import { EnvSection } from "./env-section.js";
import { GitSection } from "./git-section.js";
import { useAgentDetailContext } from "./layout-context.js";
import { sectionAnchorId } from "./save-bar.js";

export function ResourcesTab() {
  const ctx = useAgentDetailContext();
  const envOtherKeys = useMemo(() => {
    const active = ctx.draft.draft.env.filter((i) => i.status !== "deleted");
    return (exceptKey: string | null): ReadonlySet<string> =>
      new Set(active.filter((i) => i.key !== exceptKey).map((i) => i.value.key));
  }, [ctx.draft.draft.env]);

  const gitOtherPaths = useMemo(() => {
    const active = ctx.draft.draft.git.filter((i) => i.status !== "deleted");
    return (exceptKey: string | null): ReadonlySet<string> =>
      new Set(
        active
          .filter((i) => i.key !== exceptKey)
          .map((i) => {
            const { value } = i;
            if (value.localPath) return value.localPath;
            const noQuery = value.url.split(/[?#]/)[0] ?? "";
            const last = noQuery.split(/[/:]/).filter(Boolean).pop() ?? "";
            return last.replace(/\.git$/i, "");
          })
          .filter(Boolean),
      );
  }, [ctx.draft.draft.git]);

  if (!ctx.canEditConfig || !ctx.config) return null;
  return (
    <>
      <div id={sectionAnchorId("env")}>
        <EnvSection
          items={ctx.draft.draft.env}
          otherKeys={envOtherKeys}
          onAdd={ctx.draft.addEnv}
          onUpdate={ctx.draft.updateEnv}
          onDelete={ctx.draft.deleteEnv}
          onUndoDelete={ctx.draft.undoDeleteEnv}
          disabled={ctx.agent.status !== "active"}
        />
      </div>
      <div id={sectionAnchorId("git")}>
        <GitSection
          items={ctx.draft.draft.git}
          otherPaths={gitOtherPaths}
          onAdd={ctx.draft.addGit}
          onUpdate={ctx.draft.updateGit}
          onDelete={ctx.draft.deleteGit}
          onUndoDelete={ctx.draft.undoDeleteGit}
          disabled={ctx.agent.status !== "active"}
        />
      </div>
      {ctx.dryRunText && (
        <pre
          className="whitespace-pre-wrap mono text-label"
          style={{
            padding: "var(--sp-2)",
            borderRadius: "var(--radius-input)",
            background: "var(--bg-sunken)",
            border: "var(--hairline) solid var(--border-faint)",
            color: "var(--fg-2)",
          }}
        >
          {ctx.dryRunText}
        </pre>
      )}
      {ctx.draft.summary.anyDirty && (
        <div className="text-label" style={{ color: "var(--fg-3)" }}>
          <button
            type="button"
            onClick={ctx.onRunDryRun}
            className="underline bg-transparent border-0 cursor-pointer"
            style={{ color: "var(--fg-3)" }}
            disabled={ctx.dryRunPending}
          >
            {ctx.dryRunPending ? "Computing dry-run…" : "Preview server-side diff"}
          </button>
        </div>
      )}
    </>
  );
}
