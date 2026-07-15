import type { Command } from "commander";
import { success } from "../../../cli/output.js";
import { ensureFreshAdminToken, resolveServerUrl } from "../../../core/bootstrap.js";
import { getCurrent, patchConfig, resolveAgentRecord } from "./_shared/fetchers.js";

export function registerAgentConfigSetReasoningEffortCommand(config: Command): void {
  config
    .command("set-reasoning-effort <agent> <level>")
    .description(
      'Set reasoning effort. claude-code: "" (inherit local) | low | medium | high | max. codex: low | medium | high | xhigh | max | ultra (model-dependent).',
    )
    .action(async (agentName: string, level: string) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
      const adminToken = await ensureFreshAdminToken();
      const { uuid } = await resolveAgentRecord(serverUrl, adminToken, agentName);
      const current = await getCurrent(serverUrl, adminToken, uuid);
      // The value set is provider-specific; the server validates `level`
      // against the agent's runtime provider and rejects out-of-range values
      // with a 400.
      const updated = await patchConfig(serverUrl, adminToken, uuid, current.version, { reasoningEffort: level });
      success({
        agentId: updated.agentId,
        version: updated.version,
        reasoningEffort: "reasoningEffort" in updated.payload ? updated.payload.reasoningEffort : undefined,
      });
    });
}
