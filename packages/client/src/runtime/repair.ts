import { AGENT_BIND_REJECT_REASONS, type AgentBindRejectReason } from "@first-tree/shared";

/**
 * Outcome the bind-reject repair flow asks the caller to perform after
 * rewriting authoritative state.
 */
export type RepairAction = { kind: "restart" } | { kind: "ignore" };

/**
 * P2 minimal repair: when a bind is rejected with `runtime_provider_mismatch`,
 * the connecting client is running the wrong handler for the agent. The full
 * fix requires re-fetching the authoritative provider, rewriting the local
 * agent YAML, and respawning the slot with the right handler factory.
 *
 * For now (P2), we surface a `restart` action so the operator restarts the
 * client process. Auto-repair (yaml rewrite + slot swap) lives behind a
 * follow-up that needs handler-factory hot-swap support.
 */
export function decideRepairForBindReject(reason: AgentBindRejectReason): RepairAction {
  if (reason === AGENT_BIND_REJECT_REASONS.RUNTIME_PROVIDER_MISMATCH) {
    return { kind: "restart" };
  }
  return { kind: "ignore" };
}
