import { useMemo } from "react";
import { Navigate } from "react-router";
import { Button } from "../../components/ui/button.js";
import { Section } from "../../components/ui/section.js";
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

  // Hidden from buildTabs for non-config-editable agents; redirect stale
  // deep links to Profile so we don't render a blank page.
  if (!ctx.canEditConfig) return <Navigate to="../profile" replace />;
  if (!ctx.config) return null;
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
      <div id={sectionAnchorId("git")} style={{ marginTop: "var(--sp-8)" }}>
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
      {ctx.draft.summary.anyDirty && (
        <div style={{ marginTop: "var(--sp-8)" }}>
          <Section
            title="Server preview"
            description="Validate this resource draft with the same server-side merge used during save."
            action={
              <Button type="button" size="xs" variant="outline" onClick={ctx.onRunDryRun} disabled={ctx.dryRunPending}>
                {ctx.dryRunPending ? "Computing…" : "Preview diff"}
              </Button>
            }
          >
            {ctx.dryRunText ? (
              <pre
                className="whitespace-pre-wrap mono text-label"
                style={{
                  padding: "var(--sp-3)",
                  margin: 0,
                  borderBottom: "var(--hairline) solid var(--border-faint)",
                  color: "var(--fg-2)",
                }}
              >
                {ctx.dryRunText}
              </pre>
            ) : (
              <p
                className="text-body"
                style={{
                  padding: "var(--sp-3) 0",
                  margin: 0,
                  borderBottom: "var(--hairline) solid var(--border-faint)",
                  color: "var(--fg-4)",
                }}
              >
                No preview computed yet.
              </p>
            )}
          </Section>
        </div>
      )}
    </>
  );
}
