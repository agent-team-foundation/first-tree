import { AGENT_BIND_REJECT_REASONS, type AgentBindRejectReason } from "@first-tree/shared";

/**
 * Outcome the bind-reject repair flow asks the caller to perform after
 * rewriting authoritative state.
 */
export type RepairAction = { kind: "restart" } | { kind: "ignore" };

/**
 * Decide whether a bind rejection is repairable by rebuilding the slot from
 * authoritative state. A `runtime_provider_mismatch` means the connecting
 * client bound with a handler/provider the server no longer agrees with —
 * `restart` asks the caller to re-fetch the authoritative provider, rewrite
 * the local agent YAML, and respawn the slot with the right handler factory.
 *
 * The command layer implements the `restart` action in
 * `ClientRuntime.repairRuntimeProviderMismatch` (apps/cli, issue #552); every
 * other rejection reason is handled by the connection's own retry taxonomy
 * and is `ignore` here.
 */
export function decideRepairForBindReject(reason: AgentBindRejectReason): RepairAction {
  if (reason === AGENT_BIND_REJECT_REASONS.RUNTIME_PROVIDER_MISMATCH) {
    return { kind: "restart" };
  }
  return { kind: "ignore" };
}
