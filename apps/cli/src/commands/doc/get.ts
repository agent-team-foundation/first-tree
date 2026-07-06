import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { parseVersionNumber, resolveDocBySlug } from "./_shared.js";

interface GetOptions {
  version?: string;
  agent?: string;
}

export function registerDocGetCommand(doc: Command): void {
  doc
    .command("get <slug>")
    .description("Read a document — metadata plus one version's markdown content (latest by default)")
    .option("--version <n>", "Read a specific version instead of the latest")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (slug: string, options: GetOptions) => {
      const version = options.version === undefined ? undefined : parseVersionNumber(options.version);
      try {
        const sdk = createSdk(options.agent);
        const summary = await resolveDocBySlug(sdk, slug);
        success(await sdk.getDoc(summary.id, version === undefined ? undefined : { version }));
      } catch (error) {
        handleSdkError(error);
      }
    });
}
