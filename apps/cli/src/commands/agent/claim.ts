import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import { ensureFreshAccessToken, resolveServerUrl } from "../../core/bootstrap.js";
import { cliFetch } from "../../core/cli-fetch.js";
import { print } from "../../core/output.js";
import { resolveAgent } from "../_shared/resolve-agent.js";

export function registerAgentClaimCommand(agent: Command): void {
  agent
    .command("claim <agentName>")
    .description("Become the manager of an agent (admin-only, or self-claim an unmanaged agent)")
    .option("--server <url>", "Hub server URL")
    .action(async (agentName: string, options: { server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const accessToken = await ensureFreshAccessToken();

        // Look up the authenticated member's id via /me
        const meRes = await cliFetch(`${serverUrl}/api/v1/me`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!meRes.ok) fail("ME_ERROR", `Failed to fetch current member (HTTP ${meRes.status})`, 1);
        const me = (await meRes.json()) as { memberId: string };

        const target = await resolveAgent(serverUrl, accessToken, agentName);

        const patchRes = await cliFetch(`${serverUrl}/api/v1/agents/${target.uuid}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ managerId: me.memberId }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!patchRes.ok) {
          const body = (await patchRes.json().catch(() => ({}))) as { error?: string };
          fail("CLAIM_ERROR", body.error ?? `Claim failed (HTTP ${patchRes.status})`, 1);
        }
        print.line(`  Claimed "${target.name ?? target.uuid}" — now managed by you.\n`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("CLAIM_ERROR", msg);
      }
    });
}
