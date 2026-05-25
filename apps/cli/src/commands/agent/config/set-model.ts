import type { Command } from "commander";
import { success } from "../../../cli/output.js";
import { ensureFreshAdminToken, resolveServerUrl } from "../../../core/bootstrap.js";
import { getCurrent, patchConfig, resolveAgentRecord } from "./_shared/fetchers.js";

export function registerAgentConfigSetModelCommand(config: Command): void {
  config
    .command("set-model <agent> <model>")
    .description("Replace the model field (alias: opus, sonnet, haiku — or a full id like claude-opus-4-7)")
    .action(async (agentName: string, model: string) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
      const adminToken = await ensureFreshAdminToken();
      const { uuid } = await resolveAgentRecord(serverUrl, adminToken, agentName);
      const current = await getCurrent(serverUrl, adminToken, uuid);
      const updated = await patchConfig(serverUrl, adminToken, uuid, current.version, { model });
      success({ agentId: updated.agentId, version: updated.version, model: updated.payload.model });
    });
}
