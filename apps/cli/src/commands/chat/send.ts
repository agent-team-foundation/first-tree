import type { MessageFormat } from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { readStdin } from "./_shared/io.js";

interface SendOptions {
  format: MessageFormat;
  metadata?: string;
  agent?: string;
}

export function registerChatSendCommand(chat: Command): void {
  chat
    .command("send <agentName> [message]")
    .description(
      "Send a message to an agent in the caller's current chat (the chat identified by FIRST_TREE_CHAT_ID). The recipient must already be a participant; run `chat invite <agentName>` first if they are not.",
    )
    .option("-f, --format <format>", "Message format (text|markdown|card)", "text")
    .option("-m, --metadata <json>", "JSON metadata to attach")
    .option("--agent <name>", "Agent name on the Hub (default: first configured on this client)")
    .action(async (agentName: string, message: string | undefined, options: SendOptions) => {
      try {
        const chatId = process.env.FIRST_TREE_CHAT_ID;
        if (!chatId) {
          fail(
            "NO_CHAT_CONTEXT",
            "`chat send` must be run from within an agent session that exports FIRST_TREE_CHAT_ID. " +
              "Hub keeps a single group-chat model — there is no implicit direct chat to fall back to. " +
              "To send from a shell, open the chat in the web UI instead.",
            2,
          );
        }

        const content = message ?? (await readStdin());
        if (!content) {
          fail("NO_MESSAGE", "No message provided. Pass as argument or pipe via stdin.", 2);
        }

        let metadata: Record<string, unknown> | undefined;
        if (options.metadata) {
          try {
            metadata = JSON.parse(options.metadata) as Record<string, unknown>;
          } catch {
            fail("INVALID_METADATA", "Metadata must be valid JSON.", 2);
          }
        }

        const sdk = createSdk(options.agent);

        const result = await sdk.sendMessage(chatId, {
          format: options.format,
          // Send the agent's raw content verbatim. The server owns mention
          // injection: `receiverNames` declares routing intent, and the
          // agent endpoint's `normalizeMentionsInContent` will prepend
          // `@<name>` only when the content doesn't already contain it
          // (idempotent, case-insensitive). Prepending here too would
          // double-stamp when the agent already wrote `@<name>` in the
          // body — see services/message.ts step 2c.
          content,
          metadata,
          source: "cli",
          // Server resolves the name against the current chat's participant
          // list and adds it to mentions; an unknown name fails the write
          // with a `chat invite` hint.
          receiverNames: [agentName],
        });
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
