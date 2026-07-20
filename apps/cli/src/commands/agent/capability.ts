import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { ensureFreshAccessToken, resolveServerUrl } from "../../core/bootstrap.js";
import { provisioningActorHeaders } from "../../core/provisioning-actor.js";
import { adminFetch, resolveAgentRecord } from "./config/_shared/fetchers.js";

export function registerAgentCapabilityCommands(agent: Command): void {
  const capability = agent.command("capability").description("Admin-granted standing capabilities for teammate agents");
  for (const [command, enabled] of [
    ["grant", true],
    ["revoke", false],
  ] as const) {
    capability
      .command(`${command} <agent>`)
      .description(`${command === "grant" ? "Grant" : "Revoke"} the may-provision-agents capability`)
      .action(async (agentName: string) => {
        const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
        const token = await ensureFreshAccessToken();
        const { uuid } = await resolveAgentRecord(serverUrl, token, agentName);
        const updated = await adminFetch<{ canProvisionAgents: boolean }>(
          `${serverUrl}/api/v1/agents/${uuid}/provisioning-capability`,
          {
            method: "PUT",
            adminToken: token,
            headers: provisioningActorHeaders(),
            body: JSON.stringify({ enabled }),
          },
        );
        success({ agentId: uuid, canProvisionAgents: updated.canProvisionAgents });
      });
  }
}
