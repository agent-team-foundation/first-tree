import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { parseDocStatus } from "./_shared.js";

interface ListOptions {
  project?: string;
  status?: string;
  limit?: string;
  cursor?: string;
  agent?: string;
}

export function registerDocListCommand(doc: Command): void {
  doc
    .command("list")
    .description("List the org's documents, newest activity first")
    .option("--project <project>", "Filter by project label")
    .option("--status <status>", "Filter by status: draft | in_review | approved | archived")
    .option("--limit <n>", "Page size (default 50, max 200)")
    .option("--cursor <cursor>", "Continue from a previous page's nextCursor")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (options: ListOptions) => {
      const status = options.status === undefined ? undefined : parseDocStatus(options.status);
      try {
        const sdk = createSdk(options.agent);
        const result = await sdk.listDocs({
          project: options.project,
          status,
          limit: options.limit === undefined ? undefined : Number.parseInt(options.limit, 10),
          cursor: options.cursor,
        });
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
