import {
  type AgentResourceBindingInput,
  type AgentResourcesOutput,
  PROMPT_APPEND_MAX_LENGTH,
} from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Navigate } from "react-router";
import { getAgentResources, updateAgentResources } from "../../api/agent-resources.js";
import { Button } from "../../components/ui/button.js";
import { Markdown } from "../../components/ui/markdown.js";
import { Section } from "../../components/ui/section.js";
import { Textarea } from "../../components/ui/textarea.js";
import { useAgentDetailContext } from "./layout-context.js";

export function PromptTab() {
  const ctx = useAgentDetailContext();
  const queryClient = useQueryClient();
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
    onSuccess: (next) => {
      queryClient.setQueryData(["agent-resources", ctx.uuid], next);
      queryClient.invalidateQueries({ queryKey: ["agent-config", ctx.uuid] });
      setEditor(null);
    },
  });
  if (ctx.isHuman) return <Navigate to="../profile" replace />;
  if (!ctx.config && ctx.configLoading) return null;
  const prompt = ctx.config?.payload.prompt.append ?? "";
  const canEditPrompt = ctx.canManageAgent && ctx.agent.status === "active";
  const resourceError = resourcesQuery.error instanceof Error ? resourcesQuery.error.message : null;
  const resources = resourcesQuery.data;
  const editorError = savePromptMut.error instanceof Error ? savePromptMut.error.message : null;

  function openPromptEditor() {
    if (!resources) return;
    savePromptMut.reset();
    setEditor(createPromptEditorState(resources));
  }

  function closePromptEditor() {
    savePromptMut.reset();
    setEditor(null);
  }

  return (
    <Section title="Effective prompt" description="Resolved from Team and Agent prompt resources.">
      <div style={{ padding: "var(--sp-3) 0", borderBottom: "var(--hairline) solid var(--border-faint)" }}>
        {resources ? (
          <PromptResourceBlocks
            data={resources}
            editor={editor}
            error={editorError}
            saving={savePromptMut.isPending}
            canEdit={canEditPrompt && !resourceError}
            onStartEdit={openPromptEditor}
            onBodyChange={(body) => setEditor((current) => (current ? { ...current, body } : current))}
            onCancel={closePromptEditor}
            onSubmit={(body) => savePromptMut.mutate(body)}
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
    </Section>
  );
}

type PromptEditorState = {
  body: string;
  target: PromptEditorTarget;
};

type EffectivePromptRow = AgentResourcesOutput["effective"]["prompts"][number];

type PromptEditorTarget =
  | { kind: "update-inline"; bindingIndex: number }
  | { kind: "convert-binding"; bindingIndex: number; replacesResourceId: string | null }
  | { kind: "replace-resource"; replacesResourceId: string }
  | { kind: "add-inline" };

function createPromptEditorState(data: AgentResourcesOutput): PromptEditorState {
  const existing = findInlinePromptBinding(data.bindings);
  if (existing) {
    return {
      body: existing.binding.inlinePromptBody ?? "",
      target: { kind: "update-inline", bindingIndex: existing.index },
    };
  }
  const seed = seedFromSingleTeamPrompt(data);
  return {
    body: seed.body,
    target: seed.target,
  };
}

function findInlinePromptBinding(
  bindings: readonly AgentResourceBindingInput[],
): { binding: AgentResourceBindingInput; index: number } | null {
  for (let index = 0; index < bindings.length; index++) {
    const binding = bindings[index];
    if (!binding) continue;
    if (binding.type === "prompt" && binding.mode !== "disable" && typeof binding.inlinePromptBody === "string") {
      return { binding, index };
    }
  }
  return null;
}

function seedFromSingleTeamPrompt(data: AgentResourcesOutput): { body: string; target: PromptEditorTarget } {
  const enabledTeamPrompts = data.effective.prompts.filter(
    (row) => row.mode === "enabled" && row.resourceId && row.source.startsWith("team_") && row.promptBody,
  );
  const [row] = enabledTeamPrompts;
  if (enabledTeamPrompts.length === 1 && row?.resourceId && row.promptBody) {
    const bindingIndex = row.bindingId ? findBindingIndexById(data.bindings, row.bindingId) : null;
    return {
      body: row.promptBody,
      target:
        bindingIndex === null
          ? { kind: "replace-resource", replacesResourceId: row.resourceId }
          : {
              kind: "convert-binding",
              bindingIndex,
              replacesResourceId: row.source === "team_recommended" ? row.resourceId : null,
            },
    };
  }
  return { body: "", target: { kind: "add-inline" } };
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
  onStartEdit: () => void;
  onBodyChange: (body: string) => void;
  onCancel: () => void;
  onSubmit: (body: string) => void;
}) {
  const rows = enabledPromptRows(props.data);
  const inlineBinding = findInlinePromptBinding(props.data.bindings);
  const editableBindingId = inlineBinding?.binding.id ?? null;
  const editableInlineRowExists = !!editableBindingId && rows.some((row) => row.bindingId === editableBindingId);
  const hasHiddenInlineBinding = !!editableBindingId && !editableInlineRowExists;
  const singleTeamPrompt = findSingleEnabledTeamPrompt(props.data);
  const editorIsInline = props.editor?.target.kind === "update-inline" && editableInlineRowExists;
  const editorNeedsAgentBlock = props.editor !== null && !editorIsInline;
  const shouldShowCustomPlaceholder =
    !props.editor &&
    props.canEdit &&
    (hasHiddenInlineBinding || (!editableBindingId && (rows.length === 0 || !singleTeamPrompt)));
  const blocks: ReactNode[] = rows.map((row, index) => {
    const isEditableInlineRow = !!row.bindingId && row.bindingId === editableBindingId;
    const isEditingRow = !!props.editor && editorIsInline && isEditableInlineRow;
    const action =
      props.canEdit && !props.editor && isEditableInlineRow ? (
        <PromptBlockAction label="Edit custom prompt" onClick={props.onStartEdit} />
      ) : props.canEdit && !props.editor && !editableBindingId && singleTeamPrompt?.id === row.id ? (
        <PromptBlockAction label="Customize for this agent" onClick={props.onStartEdit} />
      ) : null;

    return (
      <PromptResourceBlock key={row.id} title={promptResourceTitle(row)} action={action} separated={index > 0}>
        {isEditingRow && props.editor ? (
          <InlineCustomPromptEditor
            body={props.editor.body}
            error={props.error}
            saving={props.saving}
            onBodyChange={props.onBodyChange}
            onCancel={props.onCancel}
            onSubmit={props.onSubmit}
          />
        ) : (
          <PromptBody body={row.promptBody ?? ""} />
        )}
      </PromptResourceBlock>
    );
  });

  if (editorNeedsAgentBlock && props.editor) {
    blocks.push(
      <PromptResourceBlock
        key="agent-custom-editor"
        title="Agent Resource: custom prompt"
        separated={blocks.length > 0}
      >
        <InlineCustomPromptEditor
          body={props.editor.body}
          error={props.error}
          saving={props.saving}
          onBodyChange={props.onBodyChange}
          onCancel={props.onCancel}
          onSubmit={props.onSubmit}
        />
      </PromptResourceBlock>,
    );
  } else if (shouldShowCustomPlaceholder) {
    blocks.push(
      <PromptResourceBlock
        key="agent-custom-placeholder"
        title="Agent Resource: custom prompt"
        action={
          <PromptBlockAction
            label={hasHiddenInlineBinding ? "Edit custom prompt" : "Add custom prompt"}
            onClick={props.onStartEdit}
          />
        }
        separated={blocks.length > 0}
      >
        <span className="text-muted-foreground">
          {hasHiddenInlineBinding
            ? "No prompt body."
            : rows.length === 0
              ? "No prompt resources enabled."
              : "No custom prompt yet."}
        </span>
      </PromptResourceBlock>,
    );
  }

  return (
    <PromptPanel>
      {blocks.length > 0 ? blocks : <span className="text-muted-foreground">No prompt resources enabled.</span>}
    </PromptPanel>
  );
}

function PromptFallbackPanel(props: { prompt: string }) {
  return (
    <PromptPanel minHeight={props.prompt ? "10rem" : undefined} sunken={!props.prompt}>
      {props.prompt ? (
        <Markdown>{props.prompt}</Markdown>
      ) : (
        <span className="text-muted-foreground">No prompt resources enabled.</span>
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

function PromptResourceBlock(props: { title: string; action?: ReactNode; children: ReactNode; separated?: boolean }) {
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

function PromptBlockAction(props: { label: string; onClick: () => void }) {
  return (
    <Button type="button" size="xs" variant="outline" onClick={props.onClick}>
      <Pencil className="h-3 w-3" />
      {props.label}
    </Button>
  );
}

function PromptBody(props: { body: string }) {
  return props.body ? (
    <Markdown>{props.body}</Markdown>
  ) : (
    <span className="text-muted-foreground">No prompt body.</span>
  );
}

function enabledPromptRows(data: AgentResourcesOutput): EffectivePromptRow[] {
  return data.effective.prompts.filter((row) => row.mode === "enabled" && !!row.promptBody);
}

function findSingleEnabledTeamPrompt(data: AgentResourcesOutput): EffectivePromptRow | null {
  const rows = enabledPromptRows(data).filter((row) => row.resourceId && row.source.startsWith("team_"));
  return rows.length === 1 ? (rows[0] ?? null) : null;
}

function promptResourceTitle(row: EffectivePromptRow): string {
  if (row.source.startsWith("team_")) return `Team Resource: ${row.name}`;
  if (row.source === "inline_prompt") return "Agent Resource: inline prompt";
  return `Agent Resource: ${row.name}`;
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
      setLocalError("Prompt body is required.");
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
            {props.saving ? "Saving..." : "Save prompt"}
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
