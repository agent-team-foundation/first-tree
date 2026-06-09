import type { InitializeContextTreeResponse } from "@first-tree/shared";
import { useMutation } from "@tanstack/react-query";
import { GitBranchPlus, Loader2 } from "lucide-react";
import { initializeContextTree } from "../api/context-tree.js";
import { Button } from "../components/ui/button.js";

type ContextTreeInitializerProps = {
  organizationId: string | null;
  onInitialized: (result: InitializeContextTreeResponse) => void | Promise<void>;
};

export function ContextTreeInitializer({ organizationId, onInitialized }: ContextTreeInitializerProps) {
  const mutation = useMutation({
    mutationFn: () => {
      if (!organizationId) throw new Error("Organization not loaded");
      return initializeContextTree(organizationId);
    },
    onSuccess: onInitialized,
  });

  return (
    <div style={{ display: "grid", gap: "var(--sp-2)", marginBottom: "var(--sp-4)" }}>
      <Button
        type="button"
        variant="cta"
        size="sm"
        onClick={() => mutation.mutate()}
        disabled={!organizationId || mutation.isPending}
        style={{ justifySelf: "start" }}
      >
        {mutation.isPending ? (
          <Loader2 size={15} className="animate-spin" aria-hidden="true" />
        ) : (
          <GitBranchPlus size={15} aria-hidden="true" />
        )}
        Create private GitHub repo
      </Button>
      {mutation.isPending ? (
        <div
          className="text-label"
          aria-live="polite"
          style={{ display: "grid", gap: "var(--sp-1)", color: "var(--fg-3)" }}
        >
          <ProgressLine text="Creating private GitHub repo" />
          <ProgressLine text="Initializing root NODE.md" />
          <ProgressLine text="Saving team setting" />
        </div>
      ) : null}
      {mutation.error instanceof Error ? (
        <div className="text-body" style={{ color: "var(--state-error)" }}>
          {mutation.error.message}
        </div>
      ) : null}
    </div>
  );
}

function ProgressLine({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center" style={{ gap: "var(--sp-1_5)" }}>
      <Loader2 size={13} className="animate-spin" aria-hidden="true" />
      {text}
    </span>
  );
}
