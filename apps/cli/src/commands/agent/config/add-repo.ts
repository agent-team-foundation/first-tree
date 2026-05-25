import type { Command } from "commander";
import { success } from "../../../cli/output.js";
import { ensureFreshAdminToken, resolveServerUrl } from "../../../core/bootstrap.js";
import { getCurrent, patchConfig, resolveAgentRecord } from "./_shared/fetchers.js";

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
      const current = await getCurrent(serverUrl, adminToken, uuid);
      const remaining = current.payload.gitRepos.filter((r) => r.url !== url);
      const updated = await patchConfig(serverUrl, adminToken, uuid, current.version, {
        gitRepos: [...remaining, { url, ref: opts.ref, localPath: opts.path }],
      });
      success({ agentId: updated.agentId, version: updated.version, repo: url });
    });
}
