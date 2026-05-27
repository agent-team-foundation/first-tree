import { attentionMetadataSchema } from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { raiseAttention } from "../../core/attention/index.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { resolveBody } from "./_shared/body.js";
import { collectMeta, mergeMetaJson, parseMetaFlags } from "./_shared/meta.js";

interface RaiseOptions {
  chat: string;
  target: string;
  subject: string;
  body?: string;
  requiresResponse?: boolean;
  meta: string[];
  metaJson?: string;
  agent?: string;
}

export function registerAttentionRaiseCommand(parent: Command): void {
  parent
    .command("raise")
    .description("Raise a Need-Human-Attention request to a human in this chat")
    .requiredOption("--chat <id>", "Chat id (or chat name resolvable by the server) the attention is anchored to")
    .requiredOption("--target <human>", "Target human's name or agent id (must be a member of --chat)")
    .requiredOption("--subject <text>", "Short subject line (max 500 chars)")
    .option("--body <text|@file>", "Body text, or `@path/to/file.md` to load from disk")
    .option("--requires-response", "Treat as a request (the human must reply). Default: notification.")
    .option(
      "--meta <key=value>",
      "Metadata flag; repeatable. Supports dotted paths (a.b=1, items[0].label=foo).",
      collectMeta,
      [],
    )
    .option("--meta-json <json|@file>", "JSON object merged over flat --meta flags (escape hatch for complex shapes)")
    .option("--agent <name>", "Agent name on the Hub (default: first configured on this client)")
    .action(async (options: RaiseOptions) => {
      try {
        const body = resolveBody(options.body);
        const merged = mergeMetaJson(parseMetaFlags(options.meta), options.metaJson);
        const metadataResult = attentionMetadataSchema.safeParse(merged);
        if (!metadataResult.success) {
          fail(
            "INVALID_METADATA",
            `Metadata does not match attentionMetadataSchema: ${metadataResult.error.message}`,
            2,
          );
        }

        const sdk = createSdk(options.agent);
        const attention = await raiseAttention(sdk, {
          chatId: options.chat,
          target: options.target,
          subject: options.subject,
          body,
          requiresResponse: options.requiresResponse === true,
          metadata: metadataResult.data,
        });
        success(attention);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
