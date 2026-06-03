import type { Command } from "commander";
import { success } from "../../../cli/output.js";
import { ensureFreshAdminToken, resolveServerUrl } from "../../../core/bootstrap.js";
import { getAgentResources, patchAgentResources, resolveAgentRecord } from "./_shared/fetchers.js";

export function registerAgentConfigAddRepoCommand(config: Command): void {
  config
    .command("add-repo <agent> <url>")
    .description("Add a Git repo to the agent's worktree set")
    .option("--ref <ref>", "branch / tag / commit (defaults to repo HEAD)")
    .option("--path <path>", "local path relative to session cwd")
    .action(async (agentName: string, url: string, opts: { ref?: string; path?: string }) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
      const adminToken = await ensureFreshAdminToken();
      const { uuid } = await resolveAgentRecord(serverUrl, adminToken, agentName);
      const current = await getAgentResources(serverUrl, adminToken, uuid);
      const remaining = current.bindings.filter((binding) => {
        if (binding.type !== "repo") return true;
        const resource = current.availableTeamResources.find((item) => item.id === binding.resourceId);
        const payload = resource?.payload as { url?: unknown } | undefined;
        return payload?.url !== url;
      });
      const updated = await patchAgentResources(serverUrl, adminToken, uuid, {
        expectedVersion: current.version,
        bindings: [
          ...remaining,
          {
            type: "repo",
            mode: "include",
            agentExtraRepo: { url },
            repoRef: opts.ref,
            repoLocalPath: opts.path,
            order: remaining.length + 1,
          },
        ],
      });
      success({ agentId: uuid, version: updated.version, repo: url });
    });
}
