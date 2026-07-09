import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cleanWorkspaces, SessionRegistry } from "@first-tree/client";
import { defaultDataDir } from "@first-tree/shared/config";
import type { Command } from "commander";
import { print } from "../../../core/output.js";

const DEFAULT_WORKSPACE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function registerAgentWorkspaceCleanCommand(workspace: Command): void {
  workspace
    .command("clean [agent-name]")
    .description("Remove stale workspace directories (older than TTL with no active session)")
    .option("--ttl <days>", "TTL in days", String(DEFAULT_WORKSPACE_TTL_MS / (24 * 60 * 60 * 1000)))
    .action((agentName: string | undefined, options: { ttl: string }) => {
      // Commander always supplies the --ttl default ("7").
      const ttlMs = Number.parseInt(options.ttl, 10) * 24 * 60 * 60 * 1000;
      const workspacesDir = join(defaultDataDir(), "workspaces");

      if (!existsSync(workspacesDir)) {
        print.line("  No workspaces found.\n");
        return;
      }

      const agentNames = agentName ? [agentName] : readdirSync(workspacesDir);
      let totalRemoved = 0;

      for (const name of agentNames) {
        const agentWorkspaceRoot = join(workspacesDir, name);
        if (!existsSync(agentWorkspaceRoot)) continue;

        const registryPath = join(defaultDataDir(), "sessions", `${name}.json`);
        const registry = new SessionRegistry(registryPath);
        const persisted = registry.load();
        const activeChatIds = new Set<string>();
        for (const [chatId, data] of persisted) {
          if (data.status !== "evicted") {
            activeChatIds.add(chatId);
          }
        }

        const removed = cleanWorkspaces(agentWorkspaceRoot, activeChatIds, ttlMs);
        totalRemoved += removed.length;
        for (const chatId of removed) {
          print.line(`  Removed: ${name}/${chatId}\n`);
        }
      }

      print.line(`  ${totalRemoved} workspace(s) cleaned.\n`);
    });
}
