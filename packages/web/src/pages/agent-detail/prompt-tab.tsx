import {
  type AgentResourceBindingInput,
  type AgentResourcesOutput,
  PROMPT_APPEND_MAX_LENGTH,
  type PromptSection,
} from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Navigate } from "react-router";
import { getAgentResources, updateAgentResources } from "../../api/agent-resources.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog.js";
import { Markdown } from "../../components/ui/markdown.js";
import { Popover } from "../../components/ui/popover.js";
import type { RowAction as RowMenuAction } from "../../components/ui/row-actions-menu.js";
import { Section } from "../../components/ui/section.js";
import { Textarea } from "../../components/ui/textarea.js";
import { agentResourcesMutationHandlers, resourceTypeIcon } from "./capability-section.js";
import { useAgentDetailContext } from "./layout-context.js";
import { ResourceRowView, type RowMenu, type RowStatusMarker, type RowToggle } from "./resource-row.js";
import { templateSourceLabel } from "./resource-source.js";
import { titleWithSemantics, useJustSaved } from "./save-semantics.js";

type AvailablePrompt = { id: string; name: string };

// Keep long-form instructions comfortable to read without allowing Markdown
// headings to escape the restrained Agent Detail hierarchy.
const INSTRUCTION_READING_PROSE =
  "text-instruction-reading leading-[var(--text-instruction-reading--line-height)] prose-headings:font-semibold prose-h1:text-title prose-h1:mt-0 prose-h2:text-title prose-h3:text-instruction-reading prose-h4:text-instruction-reading prose-headings:mt-4 prose-headings:mb-2 prose-p:my-3 prose-ul:my-3 prose-ol:my-3 prose-li:my-1 prose-blockquote:my-3";

export function PromptTab() {
  const ctx = useAgentDetailContext();
  const queryClient = useQueryClient();
  const { justSaved, markSaved } = useJustSaved();
  const [editor, setEditor] = useState<PromptEditorState | null>(null);
  const resourcesQuery = useQuery({
    queryKey: ["agent-resources", ctx.uuid],
    queryFn: () => getAgentResources(ctx.uuid),
    enabled: !!ctx.uuid && ctx.canManageAgent && !ctx.isHuman,
    refetchOnMount: false,
  });
  const savePromptMut = useMutation({
    mutationFn: (body: string) => {
      if (!resourcesQuery.data || !editor) throw new Error("prompt resources not loaded");
      return updateAgentResources(ctx.uuid, {
        expectedVersion: resourcesQuery.data.version,
        bindings: updatePromptBindings(resourcesQuery.data.bindings, editor, body),
      });
    },
    // Same hardening as the shared resource hook (stale-GET cancel + 409 refetch).
    // `onSuccessAfter` closes the editor.
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
  // Instructions is an editor-only tab (`tabKeysFor` gates it on
  // `canEditConfig`, and the runtime config query is disabled without it).
  // Non-editors reach this route by deep link or by switching agents while on
  // it, and would otherwise land on a permanently empty editor.
  if (ctx.isHuman || !ctx.canEditConfig) return <Navigate to="../profile" replace />;
  if (!ctx.config && ctx.configLoading) return null;
  const prompt = ctx.config?.payload.prompt.append ?? "";
  const promptSections = ctx.config?.payload.prompt.sections;
  const canEditPrompt = ctx.canManageAgent && ctx.agent.status === "active";
  const resourceError = resourcesQuery.error instanceof Error ? resourcesQuery.error.message : null;
  const resources = resourcesQuery.data;
  const appliedCount = resources
    ? appliedPromptRows(resources).length
    : (promptSections?.filter((section) => section.body.trim()).length ?? (prompt.trim() ? 1 : 0));
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
      <EffectiveInstructionsBlock prompt={prompt} sections={promptSections} appliedCount={appliedCount} />
      <Section
        headingLevel={3}
        title={titleWithSemantics("Applied instructions", justSaved)}
        count={appliedCount}
        className="[&>div:first-child]:flex-row [&>div:first-child]:items-center"
        action={
          canEditPrompt && !resourceError && !editor && resources ? (
            <AddInstructionsMenu
              available={availablePrompts}
              pending={bindingMut.isPending}
              onAddCustom={() => openPromptEditor(null)}
              onEnable={enablePrompt}
              onNavigateAway={ctx.navigateAway}
            />
          ) : null
        }
      >
        <div>
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
            <PromptFallbackPanel loading={resourcesQuery.isPending} />
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
    </div>
  );
}

// Result-first: the resolved prompt is always visible before its management
// rows. The compact preview answers "what does this agent follow?" without
// turning the tab into a long document; the full ordered result remains a
// read-only Dialog.
function EffectiveInstructionsBlock({
  prompt,
  sections,
  appliedCount,
}: {
  prompt: string;
  sections?: PromptSection[];
  appliedCount: number;
}) {
  const segments = sections?.filter((s) => s.body.trim()) ?? [];
  const effectiveBody = segments.length > 0 ? segments.map((segment) => segment.body).join("\n\n") : prompt;
  const hasInstructions = effectiveBody.trim().length > 0;
  const countLabel = `${appliedCount} ${appliedCount === 1 ? "instruction" : "instructions"} applied`;

  return (
    <Dialog>
      <Section
        headingLevel={3}
        title="What this agent follows"
        count={countLabel}
        className="[&>div:first-child]:flex-row [&>div:first-child]:items-center"
        action={
          hasInstructions ? (
            <DialogTrigger asChild>
              <Button type="button" size="xs" variant="ghost">
                Read full
              </Button>
            </DialogTrigger>
          ) : null
        }
      >
        {hasInstructions ? (
          <div
            data-instruction-result-preview
            style={{
              borderLeft: "var(--hairline-bold) solid var(--border)",
              margin: "var(--sp-3) 0",
              paddingLeft: "var(--sp-3)",
            }}
          >
            <p className="text-eyebrow" style={{ color: "var(--fg-4)", margin: "0 0 var(--sp-1)" }}>
              Read-only preview
            </p>
            <p
              className="m-0 text-instruction-preview"
              data-line-clamp="4"
              style={{
                color: "var(--fg-2)",
                display: "-webkit-box",
                WebkitBoxOrient: "vertical",
                WebkitLineClamp: 4,
                overflow: "hidden",
              }}
            >
              {promptExcerpt(effectiveBody)}
            </p>
          </div>
        ) : (
          <p className="m-0 text-body" style={{ color: "var(--fg-4)", padding: "var(--sp-3) 0" }}>
            No additional instructions are active.
          </p>
        )}
      </Section>
      {hasInstructions ? (
        <DialogContent className="max-h-[calc(100vh-var(--sp-8))] w-[calc(100%-var(--sp-4))] max-w-2xl grid-rows-[auto_minmax(0,1fr)]">
          <DialogHeader>
            <DialogTitle>What this agent follows</DialogTitle>
            <DialogDescription className="sr-only">
              Read-only instructions applied to this agent, shown in their effective order.
            </DialogDescription>
          </DialogHeader>
          <div
            className="min-h-0 overflow-y-auto"
            data-instruction-result-prose
            style={{ paddingRight: "var(--sp-2)" }}
          >
            {segments.length > 0 ? (
              segments.map((section, index) => (
                <section
                  key={`${section.scope}:${section.name}:${section.body.length}`}
                  style={
                    index > 0
                      ? {
                          marginTop: "var(--sp-4)",
                          paddingTop: "var(--sp-4)",
                          borderTop: "var(--hairline) solid var(--border-faint)",
                        }
                      : undefined
                  }
                >
                  <p className="text-eyebrow" style={{ color: "var(--fg-4)", margin: "0 0 var(--sp-2)" }}>
                    {segmentLabel(section)}
                  </p>
                  <Markdown className={INSTRUCTION_READING_PROSE}>{section.body}</Markdown>
                </section>
              ))
            ) : (
              <Markdown className={INSTRUCTION_READING_PROSE}>{prompt}</Markdown>
            )}
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

// A provenance label for each merged instruction segment: "<name> · <source>",
// aligned with the source rows below so a segment maps cleanly to its row. The
// name is the resource's own (the same `row.name` the row shows); the agent's
// standalone inline fragment carries no name, so it reads "Custom instructions"
// exactly like its row does.
function segmentLabel(section: PromptSection): string {
  const name = section.name.trim() || "Custom instructions";
  const source =
    section.scope === "team"
      ? "Team instruction"
      : section.editable
        ? "Editable for this agent"
        : "Customized for this agent";
  return `${name} · ${source}`;
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
  // Each row exposes a short readable summary by default and expands in place.
  // Only rows that contribute to the effective prompt live in Applied;
  // disabled, replaced, unavailable, and empty orphan bindings stay explainable
  // under Not applied without inflating the count above.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const rows = appliedPromptRows(props.data);
  const templateNameById = new Map(props.data.adoptedTemplates.map((summary) => [summary.id, summary.name]));
  // Disabled / overridden prompts are hidden from the active list, but the user
  // must still be able to re-enable or revert them — render them below.
  const inactiveRows = props.data.effective.prompts.filter((row) => !isAppliedPromptRow(row));
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

  const appliedBlocks: ReactNode[] = rows.map((row) => {
    const isEditingRow = !!props.editor && editorIsInline && props.editor.rowId === row.id;
    const controls = props.editor || !props.canEdit ? {} : promptRowControls(row, props);
    return (
      <PromptResourceBlock
        key={row.id}
        name={promptBlockName(row)}
        source={row.source}
        customizedFromTeam={!!row.replacesResourceId}
        templateName={row.originTemplateId ? (templateNameById.get(row.originTemplateId) ?? null) : undefined}
        marker={promptStatusMarker(row.mode)}
        toggle={controls.toggle}
        menu={controls.menu}
        body={row.promptBody ?? ""}
        unavailableReason={row.unavailableReason}
        expanded={expandedIds.has(row.id)}
        onToggle={() => toggleExpand(row.id)}
        editor={isEditingRow ? editorNode : null}
      />
    );
  });

  if (editorNeedsAgentBlock) {
    appliedBlocks.push(
      <PromptResourceBlock
        key="agent-custom-editor"
        name={null}
        source="inline_prompt"
        body=""
        expanded
        onToggle={() => {}}
        editor={editorNode}
      />,
    );
  }

  const inactiveBlocks: ReactNode[] = [];
  for (const row of inactiveRows) {
    const isEditingRow = !!props.editor && editorIsInline && props.editor.rowId === row.id;
    // Disabled team prompt → Switch off (toggling on removes the disable binding).
    // Overridden prompt with no live replacement row (e.g. an empty inline
    // replacement) → ⋯ Remove, so it never gets stuck.
    const manageable =
      props.canEdit &&
      !props.editor &&
      !!row.bindingId &&
      (row.mode === "disabled" || !enabledBindingIds.has(row.bindingId));
    const name = promptBlockName(row) ?? "instructions";
    let toggle: RowToggle | undefined;
    let menu: RowMenu | undefined;
    if (row.mode === "enabled" && props.canEdit && !props.editor) {
      const controls = promptRowControls(row, props);
      toggle = controls.toggle;
      menu = controls.menu;
    } else if (row.mode === "unavailable" && props.canEdit && !props.editor) {
      const controls = promptRowControls(row, props);
      toggle = controls.toggle;
      menu = controls.menu;
    } else if (manageable && row.bindingId) {
      if (row.mode === "disabled") {
        toggle = {
          checked: false,
          disabled: props.busy,
          ariaLabel: `Enable ${name}`,
          onChange: () => row.bindingId && props.onRemoveBinding(row.bindingId),
        };
      } else {
        menu = {
          ariaLabel: `More actions for ${name}`,
          actions: [
            {
              key: "remove",
              label: "Remove",
              destructive: true,
              disabled: props.busy,
              onSelect: () => row.bindingId && props.onRemoveBinding(row.bindingId),
            },
          ],
        };
      }
    }
    inactiveBlocks.push(
      <PromptResourceBlock
        key={row.id}
        name={promptBlockName(row)}
        source={row.source}
        customizedFromTeam={!!row.replacesResourceId}
        templateName={row.originTemplateId ? (templateNameById.get(row.originTemplateId) ?? null) : undefined}
        marker={promptStatusMarker(row.mode)}
        toggle={toggle}
        menu={menu}
        dimmed
        body={row.promptBody ?? ""}
        unavailableReason={row.unavailableReason}
        expanded={expandedIds.has(row.id)}
        onToggle={() => toggleExpand(row.id)}
        editor={isEditingRow ? editorNode : null}
      />,
    );
  }

  for (const binding of orphanBindings) {
    const bindingId = binding.id;
    if (!bindingId) continue;
    const orphanId = `orphan:${bindingId}`;
    const isEditingOrphan = !!props.editor && props.editor.rowId === orphanId;
    const menu: RowMenu | undefined =
      props.editor || !props.canEdit
        ? undefined
        : {
            ariaLabel: "More actions for custom instructions",
            actions: [
              { key: "edit", label: "Edit custom instructions", onSelect: () => props.onEditBinding(bindingId) },
              {
                key: "remove",
                label: "Remove",
                destructive: true,
                disabled: props.busy,
                onSelect: () => props.onRemoveBinding(bindingId),
              },
            ],
          };
    inactiveBlocks.push(
      <PromptResourceBlock
        key={orphanId}
        name={null}
        source="inline_prompt"
        menu={menu}
        body=""
        expanded={isEditingOrphan}
        onToggle={() => {}}
        editor={isEditingOrphan ? editorNode : null}
      />,
    );
  }

  return (
    <>
      <div className="ad-tail-trim">
        {appliedBlocks.length > 0 ? (
          appliedBlocks
        ) : (
          <p className="m-0 text-body" style={{ color: "var(--fg-4)", padding: "var(--sp-3) 0" }}>
            No instructions are applied. Add custom instructions or enable one from your team.
          </p>
        )}
      </div>
      {inactiveBlocks.length > 0 ? (
        <section style={{ marginTop: "var(--sp-5)" }}>
          <h4 className="m-0 text-subtitle font-semibold" style={{ color: "var(--fg-3)" }}>
            Not applied
            <span className="font-normal" style={{ color: "var(--fg-4)" }}>
              {" · "}
              {inactiveBlocks.length}
            </span>
          </h4>
          <div
            className="ad-tail-trim"
            style={{ borderTop: "var(--hairline) solid var(--border)", marginTop: "var(--sp-3)" }}
          >
            {inactiveBlocks}
          </div>
        </section>
      ) : null}
    </>
  );
}

/** Converged controls for an active prompt row: a Switch for a team-recommended
 *  prompt (enable / disable in place), and a ⋯ menu for the secondary actions —
 *  Customize a team prompt, Edit a custom one, Remove a custom or opted-in one. */
function promptRowControls(
  row: EffectivePromptRow,
  props: {
    busy: boolean;
    onStartEdit: (row: EffectivePromptRow | null) => void;
    onDisable: (resourceId: string) => void;
    onRemoveBinding: (bindingId: string) => void;
  },
): { toggle?: RowToggle; menu?: RowMenu } {
  const name = promptBlockName(row) ?? "instructions";
  const removeItem: RowMenuAction = {
    key: "remove",
    label: "Remove",
    destructive: true,
    disabled: props.busy,
    onSelect: () => {
      if (row.bindingId) props.onRemoveBinding(row.bindingId);
    },
  };

  if (row.source === "inline_prompt") {
    const actions: RowMenuAction[] = [
      { key: "edit", label: "Edit custom instructions", onSelect: () => props.onStartEdit(row) },
    ];
    if (row.bindingId) actions.push(removeItem);
    return { menu: { ariaLabel: `More actions for ${name}`, actions } };
  }

  if (row.source.startsWith("team_") && row.resourceId) {
    const actions: RowMenuAction[] = [
      { key: "customize", label: "Customize for this agent", onSelect: () => props.onStartEdit(row) },
    ];
    if (row.source === "team_recommended") {
      // Switch carries enable/disable; the ⋯ keeps only Customize.
      const toggle: RowToggle = {
        checked: row.mode === "enabled",
        disabled: props.busy || row.mode === "unavailable",
        ariaLabel: `Enable ${name}`,
        onChange: (next) => {
          if (next) {
            if (row.bindingId) props.onRemoveBinding(row.bindingId);
          } else if (row.resourceId) {
            props.onDisable(row.resourceId);
          }
        },
      };
      return { toggle, menu: { ariaLabel: `More actions for ${name}`, actions } };
    }
    // team_available (opt-in): no Switch — present-or-removed.
    if (row.bindingId) actions.push(removeItem);
    return { menu: { ariaLabel: `More actions for ${name}`, actions } };
  }

  if (row.bindingId) {
    return { menu: { ariaLabel: `More actions for ${name}`, actions: [removeItem] } };
  }
  return {};
}

function PromptFallbackPanel(props: { loading: boolean }) {
  return (
    <p className="m-0 text-body" style={{ color: "var(--fg-4)", padding: "var(--sp-3) 0" }}>
      {props.loading ? "Loading instruction details…" : "Instruction details are unavailable."}
    </p>
  );
}

// One instruction row — a thin wrapper over the shared `ResourceRowView`
// primitive (the same flat skeleton the Tools & skills / Repositories rows use):
// name → ownership → status, plus Switch / ⋯. A short plain-text excerpt keeps
// the default state informative; click the row to read the full Markdown while
// the merged result remains in the result-first block above.
function PromptResourceBlock(props: {
  name: string | null;
  source: EffectivePromptRow["source"];
  customizedFromTeam?: boolean;
  /** Resolved Template name when the row was imported from one; undefined otherwise. */
  templateName?: string | null;
  marker?: RowStatusMarker;
  toggle?: RowToggle;
  menu?: RowMenu;
  dimmed?: boolean;
  body: string;
  unavailableReason?: string | null;
  expanded: boolean;
  onToggle: () => void;
  /** When present (editor active), the sunken area shows this instead of Markdown. */
  editor?: ReactNode;
}) {
  // Any non-empty body is readable on demand (click the row); only the empty
  // orphan binding falls back to the "No instructions yet." hint so it stays
  // editable/removable.
  const hasBody = props.body.trim().length > 0;
  return (
    <ResourceRowView
      name={props.name}
      source={
        <span title={props.templateName !== undefined ? templateSourceLabel(props.templateName) : undefined}>
          {instructionOwnershipLabel(props.source, !!props.customizedFromTeam)}
        </span>
      }
      status={props.marker}
      toggle={props.toggle}
      menu={props.menu}
      dimmed={props.dimmed}
      peek={instructionUnavailableReason(props.unavailableReason) ?? (hasBody ? promptExcerpt(props.body) : undefined)}
      emptyPeek={hasBody ? undefined : "No instructions yet."}
      expandLabel="instructions"
      leadingIcon={resourceTypeIcon("prompt")}
      expand={{
        canExpand: hasBody,
        expanded: props.expanded,
        onToggle: props.onToggle,
        // Cap prose to a readable measure (~66–75ch) instead of the full rail.
        body: props.body ? (
          <div className="max-w-2xl">
            <Markdown>{props.body}</Markdown>
          </div>
        ) : null,
      }}
      editor={props.editor ?? undefined}
      presentation="instruction"
    />
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
          aria-label="Add instruction"
          title="Add instruction"
          onClick={toggle}
        >
          <Plus className="h-4 w-4" />
          Add instruction
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

function appliedPromptRows(data: AgentResourcesOutput): EffectivePromptRow[] {
  return data.effective.prompts.filter(isAppliedPromptRow);
}

// Match the server's runtime projection: an enabled row contributes only when
// it carries a body. Empty Team Prompt resources remain manageable below, but
// do not inflate the applied count or contradict the read-only result.
function isAppliedPromptRow(row: EffectivePromptRow): boolean {
  return row.mode === "enabled" && !!row.promptBody;
}

function instructionOwnershipLabel(source: EffectivePromptRow["source"], customizedFromTeam: boolean): string {
  if (source === "inline_prompt") {
    return customizedFromTeam ? "For this agent · Customized from team" : "For this agent · Editable here";
  }
  if (source.startsWith("team_")) return "Team instruction · Managed by your team";
  return "For this agent · Managed here";
}

function promptStatusMarker(mode: EffectivePromptRow["mode"]): RowStatusMarker {
  if (mode === "replaced") return { label: "Replaced", tone: "neutral" };
  if (mode === "unavailable") return { label: "Can't load", tone: "error" };
  return null;
}

function instructionUnavailableReason(reason: string | null | undefined): string | undefined {
  const normalized = reason?.trim();
  if (!normalized) return undefined;
  if (normalized === "prompt_budget_exceeded") {
    return "These instructions exceed the agent's instruction limit.";
  }
  // Preserve already-readable server copy. Unknown machine codes still get a
  // safe sentence rather than leaking snake_case into the UI.
  if (/\s|[.!?]/.test(normalized)) return normalized;
  const words = normalized.replace(/[_-]+/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

function promptExcerpt(body: string): string {
  return body
    .replace(/```[^\n]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*])\s+/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function promptBlockName(row: EffectivePromptRow): string | null {
  // Inline custom prompts have no resource name — give them a literal title so the
  // row stays structurally parallel to team rows (the body peek carries identity).
  if (row.source === "inline_prompt") return "Custom instructions";
  return row.name;
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
    <form onSubmit={submit} className="max-w-2xl space-y-2">
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
            {props.saving ? "Saving…" : "Save instructions"}
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
