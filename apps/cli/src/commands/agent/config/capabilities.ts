import { AGENT_CAPABILITIES, agentCapabilitiesSchema } from "@first-tree/shared";
import type { Command } from "commander";
import { success } from "../../../cli/output.js";
import { ensureFreshAdminToken, resolveServerUrl } from "../../../core/bootstrap.js";
import { getCapabilities, patchCapabilities, resolveAgentRecord } from "./_shared/fetchers.js";

const VALID = Object.values(AGENT_CAPABILITIES).join(", ");

/**
 * `<binName> agent config set-capabilities` / `get-capabilities` — the operator
 * (admin) surface for the per-agent capability grant behind agent
 * self-provisioning (issue #1885). Admin-only and refused from inside an agent
 * session (the server enforces both). Default-deny: an agent has no capability
 * until granted here.
 */
export function registerAgentConfigCapabilitiesCommands(config: Command): void {
  config
    .command("set-capabilities <agent> [capabilities...]")
    .description(`Grant/replace an agent's capabilities (admin only). Valid: ${VALID}. Omit args to clear all.`)
    .action(async (agentName: string, capabilities: string[]) => {
      // Validate at the edge so a typo fails fast with the allowed list.
      const parsed = agentCapabilitiesSchema.parse(capabilities ?? []);
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
      const adminToken = await ensureFreshAdminToken();
      const { uuid } = await resolveAgentRecord(serverUrl, adminToken, agentName);
      const view = await patchCapabilities(serverUrl, adminToken, uuid, parsed);
      success({ agentId: view.agentId, agentCapabilities: view.agentCapabilities });
    });

  config
    .command("get-capabilities <agent>")
    .description("Show an agent's granted capabilities (and, for admins, provisioning provenance)")
    .action(async (agentName: string) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
      const adminToken = await ensureFreshAdminToken();
      const { uuid } = await resolveAgentRecord(serverUrl, adminToken, agentName);
      const view = await getCapabilities(serverUrl, adminToken, uuid);
      success({ agentId: view.agentId, agentCapabilities: view.agentCapabilities, createdBy: view.createdBy ?? null });
    });
}
