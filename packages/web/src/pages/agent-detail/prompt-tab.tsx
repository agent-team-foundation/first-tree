import {
  type AgentResourceBindingInput,
  type AgentResourcesOutput,
  PROMPT_APPEND_MAX_LENGTH,
} from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
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
  return (
    <Section
      title="Effective prompt"
      description="Resolved from Team and Agent prompt resources."
      action={
        canEditPrompt && !editor ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={resourcesQuery.isLoading || !!resourceError}
            onClick={() => {
              if (!resourcesQuery.data) return;
              setEditor(createPromptEditorState(resourcesQuery.data));
              savePromptMut.reset();
            }}
          >
            <Pencil className="h-3 w-3" />
            Edit custom prompt
          </Button>
        ) : null
      }
    >
      <div style={{ padding: "var(--sp-3) 0", borderBottom: "var(--hairline) solid var(--border-faint)" }}>
        {editor ? (
          <InlineCustomPromptEditor
            body={editor.body}
            error={savePromptMut.error instanceof Error ? savePromptMut.error.message : null}
            saving={savePromptMut.isPending}
            onBodyChange={(body) => setEditor((current) => (current ? { ...current, body } : current))}
            onCancel={() => {
              savePromptMut.reset();
              setEditor(null);
            }}
            onSubmit={(body) => savePromptMut.mutate(body)}
          />
        ) : (
          <div
            className="text-body"
            style={{
              minHeight: prompt ? "10rem" : undefined,
              border: "var(--hairline) solid var(--border-faint)",
              borderRadius: "var(--radius-panel)",
              background: prompt ? "var(--bg)" : "var(--bg-sunken)",
              padding: "var(--sp-3)",
            }}
          >
            {prompt ? (
              <Markdown>{prompt}</Markdown>
            ) : (
              <span className="text-muted-foreground">No prompt resources enabled.</span>
            )}
          </div>
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
