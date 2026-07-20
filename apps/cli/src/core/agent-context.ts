/**
 * Agent-runtime context detection.
 *
 * The First Tree client runtime spawns an agent's CLI sub-process with
 * `FIRST_TREE_AGENT_ID` in its environment (see
 * `packages/client/src/runtime/agent-io.ts`). Operator commands that have both
 * a human path and a gated agent path (e.g. `agent create`, issue #1885) use
 * this to decide which to take: inside an agent session, route through the
 * capability-gated, server-attributable agent API; from a human terminal, keep
 * the existing operator path.
 */
export function isRunningInsideAgent(): boolean {
  const id = process.env.FIRST_TREE_AGENT_ID;
  return typeof id === "string" && id.length > 0;
}
