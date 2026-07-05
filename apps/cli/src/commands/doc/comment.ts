import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { parseVersionNumber, resolveDocBySlug } from "./_shared.js";

interface CommentOptions {
  quote?: string;
  prefix?: string;
  suffix?: string;
  version?: string;
  agent?: string;
}

export function registerDocCommentCommand(doc: Command): void {
  doc
    .command("comment <slug> <body>")
    .description(
      "Add a comment to a document. With --quote it anchors to that text range in the markdown source; " +
        "without, it is a document-level comment.",
    )
    .option("--quote <exact>", "Exact text the comment anchors to")
    .option("--prefix <text>", "Disambiguating text right before the quote (only with --quote)")
    .option("--suffix <text>", "Disambiguating text right after the quote (only with --quote)")
    .option("--version <n>", "Comment against a specific version (default: latest)")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (slug: string, body: string, options: CommentOptions) => {
      if (!options.quote && (options.prefix || options.suffix)) {
        fail("INVALID_ANCHOR", "--prefix / --suffix only make sense together with --quote.", 2);
      }
      const versionNumber = options.version === undefined ? undefined : parseVersionNumber(options.version);
      try {
        const sdk = createSdk(options.agent);
        const summary = await resolveDocBySlug(sdk, slug);
        const comment = await sdk.createDocComment(summary.id, {
          body,
          versionNumber,
          anchor: options.quote ? { exact: options.quote, prefix: options.prefix, suffix: options.suffix } : undefined,
        });
        success(comment);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
