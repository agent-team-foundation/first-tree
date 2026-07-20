import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { ensureFreshAccessToken, resolveServerUrl } from "../../core/bootstrap.js";
import { cliFetch } from "../../core/cli-fetch.js";
import { provisioningActorHeaders } from "../../core/provisioning-actor.js";
import { adminFetch } from "./config/_shared/fetchers.js";

type AdminOrg = { id: string; role: string };
type OrgAgent = { uuid: string; name: string | null; displayName: string | null; organizationId: string };

async function resolveAdminOrg(serverUrl: string, token: string, requestedOrgId?: string): Promise<string> {
  const res = await cliFetch(`${serverUrl}/api/v1/me/organizations`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) fail("ORG_LIST_ERROR", `Failed to list organizations: ${res.status}`, 1);
  const orgs = (await res.json()) as AdminOrg[];
  const admins = orgs.filter((org) => org.role === "admin");
  if (requestedOrgId) {
    if (!admins.some((org) => org.id === requestedOrgId)) {
      fail("ORG_ACCESS_DENIED", `You are not an administrator of organization "${requestedOrgId}"`, 1);
    }
    return requestedOrgId;
  }
  if (admins.length !== 1) {
    fail(
      "ORG_REQUIRED",
      admins.length === 0
        ? "An organization administrator must grant or revoke this capability"
        : "Multiple administrator organizations found; pass --org <organization-id>",
      1,
    );
  }
  return admins[0].id;
}

async function resolveOrgAgent(serverUrl: string, token: string, orgId: string, agentName: string): Promise<OrgAgent> {
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const res = await cliFetch(`${serverUrl}/api/v1/orgs/${encodeURIComponent(orgId)}/agents/all?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) fail("AGENT_LIST_ERROR", `Failed to list agents in organization: ${res.status}`, 1);
    const body = (await res.json()) as { items?: OrgAgent[]; nextCursor?: string | null };
    const found = (body.items ?? []).find((candidate) => candidate.name === agentName || candidate.uuid === agentName);
    if (found) return found;
    cursor = body.nextCursor ?? undefined;
  } while (cursor);
  fail("NOT_FOUND", `Agent "${agentName}" not found in organization "${orgId}"`, 1);
}

export function registerAgentCapabilityCommands(agent: Command): void {
  const capability = agent.command("capability").description("Admin-granted standing capabilities for teammate agents");
  for (const [command, enabled] of [
    ["grant", true],
    ["revoke", false],
  ] as const) {
    capability
      .command(`${command} <agent>`)
      .description(`${command === "grant" ? "Grant" : "Revoke"} the may-provision-agents capability`)
      .option("--org <organization-id>", "Organization to administer (required when you administer multiple orgs)")
      .action(async (agentName: string, options: { org?: string }) => {
        const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
        const token = await ensureFreshAccessToken();
        const orgId = await resolveAdminOrg(serverUrl, token, options.org);
        const { uuid } = await resolveOrgAgent(serverUrl, token, orgId, agentName);
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
