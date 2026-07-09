import { readFileSync } from "node:fs";
import { docSlugSchema } from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { channelConfig } from "../../core/channel.js";
import { slugFromFilename, titleFromMarkdown } from "../../core/doc-review.js";
import { errorMessage } from "../../core/error-message.js";
import { createSdk, handleSdkError, resolveLocalAgent } from "../_shared/local-agent.js";
import { parseDocStatus } from "./_shared.js";

interface PublishOptions {
  slug?: string;
  title?: string;
  project?: string;
  note?: string;
  status?: string;
  ifChanged?: boolean;
  agent?: string;
}

export function registerDocPublishCommand(doc: Command): void {
  doc
    .command("publish <file>")
    .description(
      "Publish a markdown document to the org library. Idempotent on slug: the first publish creates the " +
        "document (version 1), every later publish of the same slug appends the next version.",
    )
    .option("--slug <slug>", "Org-unique document key (default: derived from the filename)")
    .option("--title <title>", "Document title (default: the file's first markdown heading; required on first publish)")
    .option("--project <project>", "Project / grouping label")
    .option("--note <note>", "What changed in this version — shown in the version history")
    .option("--status <status>", "Set document status: draft | in_review | approved | archived")
    .option(
      "--if-changed",
      "Skip creating a new version when content is identical to the latest one " +
        "(--title/--project/--status still apply)",
    )
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (file: string, options: PublishOptions) => {
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch (error) {
        const msg = errorMessage(error);
        fail("FILE_UNREADABLE", `Cannot read "${file}": ${msg}`, 2);
      }

      const slug = options.slug ?? slugFromFilename(file);
      if (!slug || !docSlugSchema.safeParse(slug).success) {
        fail(
          "INVALID_SLUG",
          `Cannot derive a valid slug from "${options.slug ?? file}". Pass --slug with lowercase ` +
            "alphanumerics separated by '-' or '_'.",
          2,
        );
      }

      const status = options.status === undefined ? undefined : parseDocStatus(options.status);
      const title = options.title ?? titleFromMarkdown(content) ?? undefined;

      try {
        const { serverUrl } = resolveLocalAgent(options.agent);
        const sdk = createSdk(options.agent);
        const result = await sdk.publishDoc({
          slug,
          title,
          content,
          project: options.project,
          note: options.note,
          status,
          ifChanged: options.ifChanged === true,
        });
        // Shareable reading view — paste it in chat so humans can review.
        const url = `${serverUrl.replace(/\/+$/, "")}/context/docs/${encodeURIComponent(result.slug)}`;
        const hint = result.createdVersion
          ? `Published as version ${result.version}. Share ${url} for review; pull feedback later with ` +
            `\`${channelConfig.binName} doc comments ${result.slug} --status open\`.`
          : `Content unchanged — still at version ${result.version}, no new version created.`;
        success({ ...result, url, hint });
      } catch (error) {
        handleSdkError(error);
      }
    });
}
