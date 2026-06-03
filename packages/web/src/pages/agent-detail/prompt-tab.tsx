import {
  type AgentResourceBindingInput,
  type AgentResourcesOutput,
  PROMPT_APPEND_MAX_LENGTH,
} from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Navigate } from "react-router";
import { getAgentResources, updateAgentResources } from "../../api/agent-resources.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Label } from "../../components/ui/label.js";
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
    <>
      <Section
        title="Effective prompt"
        description="Resolved from Team and Agent prompt resources."
        action={
          canEditPrompt ? (
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
        {prompt ? (
          <pre
            className="whitespace-pre-wrap text-body"
            style={{
              margin: 0,
              padding: "var(--sp-3) 0",
              borderBottom: "var(--hairline) solid var(--border-faint)",
              color: "var(--fg-2)",
            }}
          >
            {prompt}
          </pre>
        ) : (
          <p className="text-body" style={{ color: "var(--fg-4)", margin: 0, padding: "var(--sp-3) 0" }}>
            No prompt resources enabled.
          </p>
        )}
        {resourceError ? (
          <p className="text-body" style={{ color: "var(--state-error)", margin: 0, padding: "var(--sp-3) 0" }}>
            {resourceError}
          </p>
        ) : null}
      </Section>
      <CustomPromptDialog
        editor={editor}
        error={savePromptMut.error instanceof Error ? savePromptMut.error.message : null}
        saving={savePromptMut.isPending}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
        onBodyChange={(body) => setEditor((current) => (current ? { ...current, body } : current))}
        onSubmit={(body) => savePromptMut.mutate(body)}
      />
    </>
  );
}

type PromptEditorState = {
  body: string;
  target: PromptEditorTarget;
};

type PromptEditorTarget =
  | { kind: "update-inline"; bindingIndex: number }
  | { kind: "convert-binding"; bindingIndex: number }
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
          : { kind: "convert-binding", bindingIndex },
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
      index === target.bindingIndex
        ? {
            ...binding,
            resourceId: null,
            inlinePromptBody: body,
            replacesResourceId: binding.mode === "replace" ? binding.replacesResourceId : null,
          }
        : binding,
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

function nextOrder(bindings: readonly AgentResourceBindingInput[]): number {
  return bindings.reduce((max, binding) => Math.max(max, binding.order ?? 0), 0) + 1;
}

function CustomPromptDialog(props: {
  editor: PromptEditorState | null;
  error: string | null;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onBodyChange: (body: string) => void;
  onSubmit: (body: string) => void;
}) {
  const [localError, setLocalError] = useState<string | null>(null);
  const body = props.editor?.body ?? "";
  const open = props.editor !== null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) {
      setLocalError("Prompt body is required.");
      return;
    }
    setLocalError(null);
    props.onSubmit(body);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setLocalError(null);
        props.onOpenChange(nextOpen);
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Edit custom prompt</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="custom-prompt-body">Body</Label>
            <Textarea
              id="custom-prompt-body"
              value={body}
              onChange={(e) => {
                setLocalError(null);
                props.onBodyChange(e.target.value);
              }}
              className="min-h-64 font-mono"
              maxLength={PROMPT_APPEND_MAX_LENGTH}
              spellCheck={false}
            />
            <p className="text-caption m-0" style={{ color: "var(--fg-4)" }}>
              {body.length.toLocaleString()} / {PROMPT_APPEND_MAX_LENGTH.toLocaleString()}
            </p>
          </div>
          {localError || props.error ? (
            <p className="text-body" style={{ color: "var(--state-error)" }}>
              {localError ?? props.error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)} disabled={props.saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={props.saving}>
              {props.saving ? "Saving..." : "Save prompt"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
