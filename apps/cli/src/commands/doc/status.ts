import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { parseDocStatus, resolveDocBySlug } from "./_shared.js";

interface StatusOptions {
  set?: string;
  agent?: string;
}

export function registerDocStatusCommand(doc: Command): void {
  doc
    .command("status <slug>")
    .description("Show a document's status, or move it with --set (draft | in_review | approved | archived)")
    .option("--set <status>", "Transition the document to this status")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (slug: string, options: StatusOptions) => {
      const status = options.set === undefined ? undefined : parseDocStatus(options.set);
      try {
        const sdk = createSdk(options.agent);
        const summary = await resolveDocBySlug(sdk, slug);
        success(status === undefined ? summary : await sdk.setDocStatus(summary.id, status));
      } catch (error) {
        handleSdkError(error);
      }
    });
}
