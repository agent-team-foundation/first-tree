import { cleanAgentWorkspaces } from "@first-tree/client";
import type { Command } from "commander";
import { print } from "../../../core/output.js";

/** Presentation default for `--ttl` (days). Kept local so CLI Client mocks need not know it. */
const DEFAULT_WORKSPACE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function registerAgentWorkspaceCleanCommand(workspace: Command): void {
  workspace
    .command("clean [agent-name]")
    .description("Remove stale workspace directories (older than TTL with no active session)")
    .option("--ttl <days>", "TTL in days", String(DEFAULT_WORKSPACE_TTL_MS / (24 * 60 * 60 * 1000)))
    .action((agentName?: string, options?: { ttl: string }) => {
      const defaultDays = DEFAULT_WORKSPACE_TTL_MS / (24 * 60 * 60 * 1000);
      const ttlMs = Number.parseInt(options?.ttl ?? String(defaultDays), 10) * 24 * 60 * 60 * 1000;

      const result = cleanAgentWorkspaces({ agentName, ttlMs });
      if (result.kind === "missing-root") {
        print.line("  No workspaces found.\n");
        return;
      }

      for (const entry of result.removed) {
        print.line(`  Removed: ${entry.agentName}/${entry.chatId}\n`);
      }
      print.line(`  ${result.removed.length} workspace(s) cleaned.\n`);
    });
}
