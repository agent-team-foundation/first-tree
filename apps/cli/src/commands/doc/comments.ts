import type { Command } from "commander";
import { success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { parseDocCommentStatus, parseVersionNumber, resolveDocBySlug } from "./_shared.js";

interface CommentsOptions {
  status?: string;
  version?: string;
  agent?: string;
}

export function registerDocCommentsCommand(doc: Command): void {
  doc
    .command("comments <slug>")
    .description(
      "List a document's review comments. Each anchored comment carries quote/prefix/suffix so the text " +
        "range can be located in the markdown source; use the ids with `doc reply` and `doc resolve`.",
    )
    .option("--status <status>", "Filter by thread status: open | resolved")
    .option("--version <n>", "Only comments made against one version")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (slug: string, options: CommentsOptions) => {
      const status = options.status === undefined ? undefined : parseDocCommentStatus(options.status);
      const versionNumber = options.version === undefined ? undefined : parseVersionNumber(options.version);
      try {
        const sdk = createSdk(options.agent);
        const summary = await resolveDocBySlug(sdk, slug);
        const { items } = await sdk.listDocComments(summary.id, { status, versionNumber });
        success({ documentId: summary.id, slug: summary.slug, latestVersion: summary.latestVersion, items });
      } catch (error) {
        handleSdkError(error);
      }
    });
}
