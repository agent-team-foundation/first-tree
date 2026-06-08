import {
  type AgentResourceBindingInput,
  type AgentResourcesOutput,
  PROMPT_APPEND_MAX_LENGTH,
} from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Navigate } from "react-router";
import { getAgentResources, updateAgentResources } from "../../api/agent-resources.js";
import { Button } from "../../components/ui/button.js";
import { Markdown } from "../../components/ui/markdown.js";
import { Popover } from "../../components/ui/popover.js";
import { Section } from "../../components/ui/section.js";
import { StatusGlyph } from "../../components/ui/status-glyph.js";
import { Textarea } from "../../components/ui/textarea.js";
import { agentResourcesMutationHandlers } from "./capability-section.js";
import { useAgentDetailContext } from "./layout-context.js";
import { sourceLabel } from "./resource-source.js";
import { titleWithSemantics, useJustSaved } from "./save-semantics.js";

type AvailablePrompt = { id: string; name: string };

export function PromptTab() {
  const ctx = useAgentDetailContext();
  const queryClient = useQueryClient();
  const { justSaved, markSaved } = useJustSaved();
  const [editor, setEditor] = useState<PromptEditorState | null>(null);
  const resourcesQuery = useQuery({
    queryKey: ["agent-resources", ctx.uuid],
    queryFn: () => getAgentResources(ctx.uuid),
    enabled: !!ctx.uuid && ctx.canManageAgent && !ctx.isHuman,
  });
  const savePromptMut = useMutation({
    mutationFn: (body: string) => {
      if (!resourcesQuery.data || !editor) throw new Error("prompt resources not loaded");
      return updateAgentResources(ctx.uuid, {
        expectedVersion: resourcesQuery.data.version,
        bindings: updatePromptBindings(resourcesQuery.data.bindings, editor, body),
      });
    },
    // Same hardening as the shared resource hook (stale-GET cancel + 409 refetch),
    // since the shell now also observes this cache. `onSuccessAfter` closes the editor.
    ...agentResourcesMutationHandlers(queryClient, ctx.uuid, {
      onSuccessAfter: () => {
        setEditor(null);
        markSaved();
      },
    }),
  });
  // All prompt-binding management (enable / disable / remove / re-enable) goes
  // through one mutation that submits the full bindings array. The old Resources
  // tab is gone, so the Prompt tab is now the only surface that manages these.
  const bindingMut = useMutation({
    mutationFn: (bindings: AgentResourceBindingInput[]) => {
      if (!resourcesQuery.data) throw new Error("prompt resources not loaded");
      return updateAgentResources(ctx.uuid, { expectedVersion: resourcesQuery.data.version, bindings });
    },
    ...agentResourcesMutationHandlers(queryClient, ctx.uuid, { onSuccessAfter: markSaved }),
  });
  if (ctx.isHuman) return <Navigate to="../profile" replace />;
  if (!ctx.config && ctx.configLoading) return null;
  const prompt = ctx.config?.payload.prompt.append ?? "";
  const canEditPrompt = ctx.canManageAgent && ctx.agent.status === "active";
  const resourceError = resourcesQuery.error instanceof Error ? resourcesQuery.error.message : null;
  const resources = resourcesQuery.data;
  const editorError = savePromptMut.error instanceof Error ? savePromptMut.error.message : null;
  const bindingError = bindingMut.error instanceof Error ? bindingMut.error.message : null;
  const bindings = resources?.bindings ?? [];
  // A team prompt is "active" if a binding includes it OR overrides it (replace),
  // so an overridden prompt never reappears in the Available list.
  const activeResourceIds = new Set(
    bindings.flatMap((b) => [b.resourceId, b.replacesResourceId]).filter((id): id is string => !!id),
  );
  const availablePrompts = (resources?.availableTeamResources ?? []).filter(
    (resource) =>
      resource.type === "prompt" && resource.defaultEnabled === "available" && !activeResourceIds.has(resource.id),
  );

  function enablePrompt(resourceId: string) {
    bindingMut.mutate([...bindings, { type: "prompt", mode: "include", resourceId, order: nextOrder(bindings) }]);
  }
  function disablePrompt(resourceId: string) {
    // Drop any existing include/replace binding for this resource first — otherwise
    // the resolver sees include + disable and the prompt stays enabled at runtime.
    bindingMut.mutate([
      ...bindings.filter((b) => b.resourceId !== resourceId && b.replacesResourceId !== resourceId),
      { type: "prompt", mode: "disable", resourceId, order: nextOrder(bindings) },
    ]);
  }
  function removeBinding(bindingId: string) {
    bindingMut.mutate(bindings.filter((binding) => binding.id !== bindingId));
  }

  // Edit an inline binding that has no effective row (e.g. an empty body the
  // backend drops). Without this the binding is invisible and unremovable.
  function editBinding(bindingId: string) {
    if (!resources) return;
    savePromptMut.reset();
    const index = resources.bindings.findIndex((binding) => binding.id === bindingId);
    if (index < 0) return;
    setEditor({
      rowId: `orphan:${bindingId}`,
      body: resources.bindings[index]?.inlinePromptBody ?? "",
      target: { kind: "update-inline", bindingIndex: index },
    });
  }

  function openPromptEditor(row: EffectivePromptRow | null) {
    if (!resources) return;
    savePromptMut.reset();
    setEditor(createPromptEditorState(resources, row));
  }

  function closePromptEditor() {
    savePromptMut.reset();
    setEditor(null);
  }

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
      <Section
        title={titleWithSemantics("Instructions", "immediate", justSaved)}
        description="Team and your own instructions for this agent — toggle, customize, or add your own."
        action={
          canEditPrompt && !resourceError && !editor && resources ? (
            <AddInstructionsMenu
              available={availablePrompts}
              pending={bindingMut.isPending}
              onAddCustom={() => openPromptEditor(null)}
              onEnable={enablePrompt}
              onNavigateAway={ctx.guardedNavigate}
            />
          ) : null
        }
      >
        <div style={{ padding: "var(--sp-3) 0", borderBottom: "var(--hairline) solid var(--border-faint)" }}>
          {resources ? (
            <PromptResourceBlocks
              data={resources}
              editor={editor}
              error={editorError}
              saving={savePromptMut.isPending}
              canEdit={canEditPrompt && !resourceError}
              busy={bindingMut.isPending}
              onStartEdit={openPromptEditor}
              onBodyChange={(body) => setEditor((current) => (current ? { ...current, body } : current))}
              onCancel={closePromptEditor}
              onSubmit={(body) => savePromptMut.mutate(body)}
              onDisable={disablePrompt}
              onRemoveBinding={removeBinding}
              onEditBinding={editBinding}
            />
          ) : (
            <PromptFallbackPanel prompt={prompt} />
          )}
        </div>
        {resourceError ? (
          <p className="text-body" style={{ color: "var(--state-error)", margin: 0, padding: "var(--sp-3) 0" }}>
            {resourceError}
          </p>
        ) : null}
        {bindingError ? (
          <p className="text-body" style={{ color: "var(--state-error)", margin: 0, padding: "var(--sp-3) 0" }}>
            {bindingError}
          </p>
        ) : null}
      </Section>
      <div id="ad-effective-instructions">
        <Section
          title="Effective instructions"
          description="The full instructions this agent runs with, after your changes — team and custom, in order."
        >
          <div style={{ paddingTop: "var(--sp-3)" }}>
            <PromptPanel minHeight={prompt ? "10rem" : undefined} sunken={!prompt}>
              {prompt ? (
                <Markdown>{prompt}</Markdown>
              ) : (
                <span className="text-muted-foreground">No instructions yet.</span>
              )}
            </PromptPanel>
          </div>
        </Section>
      </div>
    </div>
  );
}

type PromptEditorState = {
  /** Effective row being edited; null for a brand-new standalone custom prompt. */
  rowId: string | null;
  body: string;
  target: PromptEditorTarget;
};

type EffectivePromptRow = AgentResourcesOutput["effective"]["prompts"][number];

type PromptEditorTarget =
  | { kind: "update-inline"; bindingIndex: number }
  | { kind: "convert-binding"; bindingIndex: number; replacesResourceId: string | null }
  | { kind: "replace-resource"; replacesResourceId: string }
  | { kind: "add-inline" };

function createPromptEditorState(data: AgentResourcesOutput, row: EffectivePromptRow | null): PromptEditorState {
  // Brand-new standalone custom prompt (not tied to any team prompt).
  if (!row) return { rowId: null, body: "", target: { kind: "add-inline" } };

  const bindingIndex = row.bindingId ? findBindingIndexById(data.bindings, row.bindingId) : null;
  const binding = bindingIndex !== null ? data.bindings[bindingIndex] : null;

  // Editing an existing custom prompt (inline body or a replacement) in place.
  if (bindingIndex !== null && binding && typeof binding.inlinePromptBody === "string") {
    return { rowId: row.id, body: binding.inlinePromptBody ?? "", target: { kind: "update-inline", bindingIndex } };
  }

  // Customizing a team prompt → create a replacement for that specific prompt.
  if (row.resourceId) {
    return {
      rowId: row.id,
      body: row.promptBody ?? "",
      target:
        bindingIndex === null
          ? { kind: "replace-resource", replacesResourceId: row.resourceId }
          : {
              // Always keep the override tied to the original team prompt (recommended
              // or available), so the original doesn't reappear as a duplicate.
              kind: "convert-binding",
              bindingIndex,
              replacesResourceId: row.resourceId,
            },
    };
  }

  return { rowId: row.id, body: row.promptBody ?? "", target: { kind: "add-inline" } };
}

function findBindingIndexById(bindings: readonly AgentResourceBindingInput[], bindingId: string): number | null {
  const index = bindings.findIndex((binding) => binding.id === bindingId);
  return index >= 0 ? index : null;
}

function updatePromptBindings(
  bindings: readonly AgentResourceBindingInput[],
  editor: PromptEditorState,
  body: string,
): AgentResourceBindingInput[] {
  const target = editor.target;
  if (target.kind === "update-inline") {
    return bindings.map((binding, index) =>
      index === target.bindingIndex ? { ...binding, inlinePromptBody: body } : binding,
    );
  }
  if (target.kind === "convert-binding") {
    return bindings.map((binding, index) =>
      index === target.bindingIndex ? convertPromptBindingToInline(binding, target.replacesResourceId, body) : binding,
    );
  }
  return [
    ...bindings,
    {
      type: "prompt",
      mode: target.kind === "replace-resource" ? "replace" : "include",
      resourceId: null,
      replacesResourceId: target.kind === "replace-resource" ? target.replacesResourceId : null,
      inlinePromptBody: body,
      order: nextOrder(bindings),
    },
  ];
}

function convertPromptBindingToInline(
  binding: AgentResourceBindingInput,
  replacesResourceId: string | null,
  body: string,
): AgentResourceBindingInput {
  const replaceTarget = binding.mode === "replace" ? (binding.replacesResourceId ?? null) : replacesResourceId;
  return {
    ...binding,
    mode: replaceTarget ? "replace" : "include",
    resourceId: null,
    inlinePromptBody: body,
    replacesResourceId: replaceTarget,
  };
}

function nextOrder(bindings: readonly AgentResourceBindingInput[]): number {
  return bindings.reduce((max, binding) => Math.max(max, binding.order ?? 0), 0) + 1;
}

function PromptResourceBlocks(props: {
  data: AgentResourcesOutput;
  editor: PromptEditorState | null;
  error: string | null;
  saving: boolean;
  canEdit: boolean;
  busy: boolean;
  onStartEdit: (row: EffectivePromptRow | null) => void;
  onBodyChange: (body: string) => void;
  onCancel: () => void;
  onSubmit: (body: string) => void;
  onDisable: (resourceId: string) => void;
  onRemoveBinding: (bindingId: string) => void;
  onEditBinding: (bindingId: string) => void;
}) {
  // Every instruction block collapses to a short summary by default and expands
  // to its full body on demand — same affordance whether the block is enabled or
  // inactive (disabled / overridden). This keeps the list scannable while the
  // bottom "Effective instructions" panel stays the single full merged preview.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const rows = enabledPromptRows(props.data);
  // Disabled / overridden prompts are hidden from the active list, but the user
  // must still be able to re-enable or revert them — render them below.
  const inactiveRows = props.data.effective.prompts.filter((row) => row.mode === "disabled" || row.mode === "replaced");
  // Inline prompt bindings the backend produced no effective row for (e.g. an
  // empty body it drops): keep them visible so they can be edited or removed —
  // an unremovable empty include binding otherwise makes every save fail.
  const renderedBindingIds = new Set<string>();
  for (const row of [...rows, ...inactiveRows]) if (row.bindingId) renderedBindingIds.add(row.bindingId);
  // Bindings that already show an active (editable) row — used so a "replaced"
  // row only offers its own Remove when no live replacement row exists.
  const enabledBindingIds = new Set<string>();
  for (const row of rows) if (row.bindingId) enabledBindingIds.add(row.bindingId);
  const orphanBindings = props.data.bindings.filter(
    (binding) =>
      binding.type === "prompt" && binding.mode !== "disable" && !!binding.id && !renderedBindingIds.has(binding.id),
  );
  // Editing an existing custom prompt happens in place; customizing a team
  // prompt (replace / convert) or adding a new one renders as its own block.
  const editorIsInline = props.editor?.target.kind === "update-inline";
  const editorNeedsAgentBlock = props.editor !== null && !editorIsInline;

  const editorNode = props.editor ? (
    <InlineCustomPromptEditor
      body={props.editor.body}
      error={props.error}
      saving={props.saving}
      onBodyChange={props.onBodyChange}
      onCancel={props.onCancel}
      onSubmit={props.onSubmit}
    />
  ) : null;

  const blocks: ReactNode[] = rows.map((row, index) => {
    const isEditingRow = !!props.editor && editorIsInline && props.editor.rowId === row.id;
    const action = props.editor || !props.canEdit ? null : promptRowAction(row, props);
    const marker = row.mode === "unavailable" ? "Unavailable" : undefined;
    return (
      <PromptResourceBlock
        key={row.id}
        title={<PromptBlockHeading name={promptBlockName(row)} source={row.source} marker={marker} />}
        action={action}
        separated={index > 0}
      >
        {isEditingRow ? (
          editorNode
        ) : (
          <CollapsibleBody
            body={row.promptBody ?? ""}
            expanded={expandedIds.has(row.id)}
            onToggle={() => toggleExpand(row.id)}
          />
        )}
      </PromptResourceBlock>
    );
  });

  if (editorNeedsAgentBlock) {
    blocks.push(
      <PromptResourceBlock
        key="agent-custom-editor"
        title={<PromptBlockHeading name={null} source="inline_prompt" />}
        separated={blocks.length > 0}
      >
        {editorNode}
      </PromptResourceBlock>,
    );
  }

  for (const row of inactiveRows) {
    const marker = row.mode === "disabled" ? "Off" : "Overridden";
    // Disabled team prompt → Re-enable. Overridden prompt with no live replacement
    // row (e.g. an empty inline replacement) → Remove, so it never gets stuck.
    const manageable =
      props.canEdit &&
      !props.editor &&
      !!row.bindingId &&
      (row.mode === "disabled" || !enabledBindingIds.has(row.bindingId));
    const action = manageable ? (
      <PromptBlockAction
        label={row.mode === "disabled" ? "Re-enable" : "Remove"}
        disabled={props.busy}
        onClick={() => row.bindingId && props.onRemoveBinding(row.bindingId)}
      />
    ) : null;
    blocks.push(
      <PromptResourceBlock
        key={row.id}
        title={<PromptBlockHeading name={promptBlockName(row)} source={row.source} marker={marker} />}
        action={action}
        separated={blocks.length > 0}
      >
        <CollapsibleBody
          body={row.promptBody ?? ""}
          expanded={expandedIds.has(row.id)}
          onToggle={() => toggleExpand(row.id)}
        />
      </PromptResourceBlock>,
    );
  }

  for (const binding of orphanBindings) {
    const bindingId = binding.id;
    if (!bindingId) continue;
    const orphanId = `orphan:${bindingId}`;
    const isEditingOrphan = !!props.editor && props.editor.rowId === orphanId;
    blocks.push(
      <PromptResourceBlock
        key={orphanId}
        title={<PromptBlockHeading name={null} source="inline_prompt" />}
        action={
          props.editor || !props.canEdit ? null : (
            <div className="flex gap-2">
              <PromptBlockAction icon label="Edit custom instructions" onClick={() => props.onEditBinding(bindingId)} />
              <PromptBlockAction
                label="Remove"
                disabled={props.busy}
                onClick={() => props.onRemoveBinding(bindingId)}
              />
            </div>
          )
        }
        separated={blocks.length > 0}
      >
        {isEditingOrphan ? editorNode : <span className="text-muted-foreground">No instructions yet.</span>}
      </PromptResourceBlock>,
    );
  }

  return (
    <PromptPanel>
      {blocks.length > 0 ? blocks : <span className="text-muted-foreground">No instructions yet.</span>}
    </PromptPanel>
  );
}

/** Inline action buttons for an active prompt row, mirroring the old Resources tab:
 *  customize / edit any prompt, disable a recommended one, remove a custom or opted-in one. */
function promptRowAction(
  row: EffectivePromptRow,
  props: {
    busy: boolean;
    onStartEdit: (row: EffectivePromptRow | null) => void;
    onDisable: (resourceId: string) => void;
    onRemoveBinding: (bindingId: string) => void;
  },
): ReactNode {
  const buttons: ReactNode[] = [];
  const remove = (
    <PromptBlockAction
      key="remove"
      label="Remove"
      disabled={props.busy}
      onClick={() => row.bindingId && props.onRemoveBinding(row.bindingId)}
    />
  );
  if (row.source === "inline_prompt") {
    buttons.push(
      <PromptBlockAction key="edit" icon label="Edit custom instructions" onClick={() => props.onStartEdit(row)} />,
    );
    if (row.bindingId) buttons.push(remove);
  } else if (row.source.startsWith("team_") && row.resourceId) {
    buttons.push(
      <PromptBlockAction
        key="customize"
        icon
        label="Customize for this agent"
        onClick={() => props.onStartEdit(row)}
      />,
    );
    if (row.source === "team_recommended") {
      buttons.push(
        <PromptBlockAction
          key="disable"
          label="Disable"
          disabled={props.busy}
          onClick={() => row.resourceId && props.onDisable(row.resourceId)}
        />,
      );
    } else if (row.bindingId) {
      buttons.push(remove);
    }
  } else if (row.bindingId) {
    buttons.push(remove);
  }
  return buttons.length > 0 ? <div className="flex gap-2">{buttons}</div> : null;
}

function PromptFallbackPanel(props: { prompt: string }) {
  return (
    <PromptPanel minHeight={props.prompt ? "10rem" : undefined} sunken={!props.prompt}>
      {props.prompt ? (
        <Markdown>{props.prompt}</Markdown>
      ) : (
        <span className="text-muted-foreground">No instructions yet.</span>
      )}
    </PromptPanel>
  );
}

function PromptPanel(props: { children: ReactNode; minHeight?: string; sunken?: boolean }) {
  return (
    <div
      className="text-body"
      style={{
        minHeight: props.minHeight,
        border: "var(--hairline) solid var(--border-faint)",
        borderRadius: "var(--radius-panel)",
        background: props.sunken ? "var(--bg-sunken)" : "var(--bg)",
        padding: "var(--sp-3)",
      }}
    >
      {props.children}
    </div>
  );
}

function PromptResourceBlock(props: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  separated?: boolean;
}) {
  return (
    <div
      style={{
        paddingTop: props.separated ? "var(--sp-3)" : undefined,
        marginTop: props.separated ? "var(--sp-3)" : undefined,
        borderTop: props.separated ? "var(--hairline) solid var(--border-faint)" : undefined,
      }}
    >
      <div
        className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"
        style={{ marginBottom: "var(--sp-2)" }}
      >
        <h3 className="text-subtitle m-0">{props.title}</h3>
        {props.action}
      </div>
      {props.children}
    </div>
  );
}

function PromptBlockAction(props: { label: string; onClick: () => void; disabled?: boolean; icon?: boolean }) {
  return (
    <Button type="button" size="xs" variant="outline" disabled={props.disabled} onClick={props.onClick}>
      {props.icon ? <Pencil className="h-3 w-3" /> : null}
      {props.label}
    </Button>
  );
}

// One instruction block's body: a clamped summary by default, expandable to the
// full Markdown. The expand toggle only appears when there's more to reveal than
// the 2-line clamp shows (long body or multi-line), so short prompts stay clean.
function CollapsibleBody(props: { body: string; expanded: boolean; onToggle: () => void }) {
  if (!props.body) return <span className="text-muted-foreground">No instructions yet.</span>;
  const canExpand = props.body.length > 120 || props.body.includes("\n");
  return (
    <div>
      {props.expanded ? (
        <Markdown>{props.body}</Markdown>
      ) : (
        <p className="m-0 text-caption line-clamp-2" style={{ color: "var(--fg-3)" }}>
          {props.body}
        </p>
      )}
      {canExpand ? <ExpandToggle expanded={props.expanded} onToggle={props.onToggle} /> : null}
    </div>
  );
}

function ExpandToggle(props: { expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onToggle}
      aria-expanded={props.expanded}
      className="mt-1 bg-transparent border-0 p-0 cursor-pointer text-caption font-medium transition-colors hover:text-[var(--fg)]"
      style={{ color: "var(--fg-3)" }}
    >
      {props.expanded ? "Show less" : "Show full"}
    </button>
  );
}

// Per-section add control on the Instructions tab. One "+" trigger opens a menu:
// add a custom inline instruction, enable an optional team instruction, or jump
// to Settings → Resources. Mirrors the Tools & skills "Add" menu so the two add
// paths (custom vs team) live in one place instead of a separate section.
function AddInstructionsMenu(props: {
  available: AvailablePrompt[];
  pending: boolean;
  onAddCustom: () => void;
  onEnable: (resourceId: string) => void;
  /** Leave-guarded navigate for the "Manage in Settings" exit. */
  onNavigateAway: (to: string) => void;
}) {
  return (
    <Popover
      align="end"
      trigger={({ open, toggle }) => (
        <Button
          size="xs"
          variant="outline"
          aria-expanded={open}
          aria-label="Add instructions"
          title="Add instructions"
          onClick={toggle}
        >
          <Plus className="h-3 w-3" />
          Add
        </Button>
      )}
    >
      {({ close }) => (
        <div style={{ padding: "var(--sp-1)", minWidth: "var(--sp-45)" }}>
          <InstructionsMenuButton
            onClick={() => {
              props.onAddCustom();
              close();
            }}
          >
            Add custom instructions…
          </InstructionsMenuButton>
          {props.available.length > 0 ? (
            <>
              <p className="text-label" style={{ color: "var(--fg-4)", margin: 0, padding: "var(--sp-1) var(--sp-2)" }}>
                Enable from team
              </p>
              {props.available.map((resource) => (
                <InstructionsMenuButton
                  key={resource.id}
                  disabled={props.pending}
                  onClick={() => {
                    props.onEnable(resource.id);
                    close();
                  }}
                >
                  {resource.name}
                </InstructionsMenuButton>
              ))}
            </>
          ) : null}
          <div style={{ borderTop: "var(--hairline) solid var(--border-faint)", margin: "var(--sp-1) 0" }} />
          <InstructionsMenuButton
            muted
            onClick={() => {
              props.onNavigateAway("/settings/resources");
              close();
            }}
          >
            Manage in Settings → Resources
          </InstructionsMenuButton>
        </div>
      )}
    </Popover>
  );
}

function InstructionsMenuButton(props: {
  children: ReactNode;
  muted?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      className="flex w-full items-center text-left text-body transition-colors hover:bg-[var(--bg-hover)] disabled:pointer-events-none disabled:opacity-50"
      style={{
        gap: "var(--sp-2)",
        padding: "var(--sp-1_5) var(--sp-2)",
        borderRadius: "var(--radius-chip)",
        border: 0,
        background: "transparent",
        color: props.muted ? "var(--fg-3)" : "var(--fg)",
        cursor: "pointer",
      }}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function enabledPromptRows(data: AgentResourcesOutput): EffectivePromptRow[] {
  // Active list = enabled + unavailable (e.g. budget-exceeded). Include blank-body
  // rows too: a team prompt can legitimately have an empty body and still needs its
  // management controls. (The backend only drops blank *inline* bindings, which the
  // orphan-binding path below recovers — those never produce a row here.)
  return data.effective.prompts.filter((row) => row.mode === "enabled" || row.mode === "unavailable");
}

function promptBlockName(row: EffectivePromptRow): string | null {
  // Inline prompts have no meaningful resource name — the source label says it all.
  if (row.source === "inline_prompt") return null;
  return row.name;
}

function PromptBlockHeading(props: { name: string | null; source: EffectivePromptRow["source"]; marker?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      {props.name ? <span>{props.name}</span> : null}
      <span className="text-caption font-normal" style={{ color: "var(--fg-4)" }}>
        {sourceLabel(props.source)}
      </span>
      {props.marker ? (
        <span
          className="mono inline-flex items-center gap-1.5 text-caption font-normal"
          style={{ color: "var(--fg-4)" }}
        >
          <StatusGlyph colorVar="var(--fg-4)" shape="dot" size={7} ariaLabel={props.marker} />
          {props.marker}
        </span>
      ) : null}
    </span>
  );
}

function InlineCustomPromptEditor(props: {
  body: string;
  error: string | null;
  saving: boolean;
  onBodyChange: (body: string) => void;
  onCancel: () => void;
  onSubmit: (body: string) => void;
}) {
  const [localError, setLocalError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const countLabel = `${props.body.length.toLocaleString()} / ${PROMPT_APPEND_MAX_LENGTH.toLocaleString()}`;

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    resizeTextarea(ta);
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!props.body.trim()) {
      setLocalError("Instructions are required.");
      return;
    }
    setLocalError(null);
    props.onSubmit(props.body);
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <Textarea
        id="custom-prompt-body"
        ref={taRef}
        value={props.body}
        onChange={(e) => {
          setLocalError(null);
          props.onBodyChange(e.target.value);
          resizeTextarea(e.currentTarget);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setLocalError(null);
            props.onCancel();
          }
        }}
        className="resize-none overflow-hidden font-mono"
        style={{ minHeight: "16rem" }}
        placeholder="Add persistent instructions for how this agent should behave."
        maxLength={PROMPT_APPEND_MAX_LENGTH}
        spellCheck={false}
        disabled={props.saving}
      />
      {localError || props.error ? (
        <p className="text-body" style={{ color: "var(--state-error)" }}>
          {localError ?? props.error}
        </p>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-caption m-0" style={{ color: "var(--fg-4)" }}>
          {countLabel}
        </p>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => {
              setLocalError(null);
              props.onCancel();
            }}
            disabled={props.saving}
          >
            Cancel
          </Button>
          <Button type="submit" size="xs" variant="outline" disabled={props.saving}>
            {props.saving ? "Saving..." : "Save instructions"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function resizeTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}
