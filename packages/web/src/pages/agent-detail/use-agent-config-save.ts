import type { AgentRuntimeConfig, AgentRuntimeConfigPatch } from "@first-tree/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { updateAgentConfig } from "../../api/agent-config.js";
import { ApiError } from "../../api/client.js";
import { useJustSaved } from "./save-semantics.js";

/**
 * Immediate-save controller for the per-agent runtime config (model / reasoning
 * effort / env). The sibling of `useAgentResources`: every edit writes through
 * the versioned `PATCH /agents/:uuid/config` endpoint as soon as it's made — no
 * draft, no Save bar. Mirrors the two protections of `agentResourcesMutationHandlers`,
 * plus an optimistic cache write so discrete controls (dropdowns) reflect the
 * change instantly:
 *  - onMutate writes the patch into the `["agent-config", uuid]` cache (version
 *    untouched) so the UI updates before the round-trip; controls disable while
 *    `pending`, so no second save races the version.
 *  - onError rolls the optimistic write back, and on a 409 refetches so a retry
 *    uses the latest version instead of dead-ending on a stale one.
 *  - onSuccess replaces the cache with the server's authoritative config and
 *    flashes "Saved" on the field that was edited.
 */

export type ConfigField = "model" | "effort" | "env";

export type AgentConfigSaveController = {
  /** Save a partial config patch immediately. `field` drives which section flashes "Saved" / shows the error. */
  save: (
    patch: AgentRuntimeConfigPatch,
    opts?: { field?: ConfigField; onSuccess?: () => void; onError?: () => void },
  ) => void;
  pending: boolean;
  /** Non-conflict save failure message, else null. */
  saveError: string | null;
  /** True after a 409 (someone else saved a newer version); cleared on the next successful save. */
  conflict: boolean;
  /** Which field's save last failed (conflict or error), so the UI can show it field-located; null when clean. */
  errorField: ConfigField | null;
  justSaved: boolean;
  savedField: ConfigField | null;
};

type SaveVars = { patch: AgentRuntimeConfigPatch; expectedVersion: number; field?: ConfigField };
type SaveContext = { prev?: AgentRuntimeConfig };

export function useAgentConfigSave(uuid: string): AgentConfigSaveController {
  const queryClient = useQueryClient();
  const { justSaved, markSaved } = useJustSaved();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [errorField, setErrorField] = useState<ConfigField | null>(null);
  const [savedField, setSavedField] = useState<ConfigField | null>(null);

  const { mutate, isPending } = useMutation<AgentRuntimeConfig, unknown, SaveVars, SaveContext>({
    mutationFn: ({ patch, expectedVersion }) => updateAgentConfig(uuid, { expectedVersion, payload: patch }),
    onMutate: async ({ patch }) => {
      await queryClient.cancelQueries({ queryKey: ["agent-config", uuid] });
      const prev = queryClient.getQueryData<AgentRuntimeConfig>(["agent-config", uuid]);
      if (prev) {
        // `patch` is the flat partial (loose `reasoningEffort: string`), while
        // `payload` is the per-provider tagged union — spreading the two widens
        // the field types, so cast the merge back to the payload shape. It's an
        // optimistic UI value only; the server response (onSuccess) is authoritative.
        const nextPayload = { ...prev.payload, ...patch } as AgentRuntimeConfig["payload"];
        queryClient.setQueryData<AgentRuntimeConfig>(["agent-config", uuid], { ...prev, payload: nextPayload });
      }
      return { prev };
    },
    onError: (err, vars, context) => {
      if (context?.prev) queryClient.setQueryData(["agent-config", uuid], context.prev);
      setErrorField(vars.field ?? null);
      if (err instanceof ApiError && err.status === 409) {
        setConflict(true);
        setSaveError(null);
        queryClient.invalidateQueries({ queryKey: ["agent-config", uuid] });
        return;
      }
      setConflict(false);
      setSaveError(err instanceof Error ? err.message : String(err));
    },
    onSuccess: async (next, vars) => {
      await queryClient.cancelQueries({ queryKey: ["agent-config", uuid] });
      queryClient.setQueryData(["agent-config", uuid], next);
      setSaveError(null);
      setConflict(false);
      setErrorField(null);
      setSavedField(vars.field ?? null);
      markSaved();
    },
  });

  const save = useCallback<AgentConfigSaveController["save"]>(
    (patch, opts) => {
      const current = queryClient.getQueryData<AgentRuntimeConfig>(["agent-config", uuid]);
      if (!current) return;
      setSaveError(null);
      setConflict(false);
      setErrorField(null);
      mutate(
        { patch, expectedVersion: current.version, field: opts?.field },
        { onSuccess: () => opts?.onSuccess?.(), onError: () => opts?.onError?.() },
      );
    },
    [queryClient, uuid, mutate],
  );

  return { save, pending: isPending, saveError, conflict, errorField, justSaved, savedField };
}
