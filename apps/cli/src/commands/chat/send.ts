import type { MessageFormat } from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { channelConfig } from "../../core/channel.js";
import { captureOutboundDocs } from "../../core/doc-capture.js";
import { print } from "../../core/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { looksLikeEscapedNewlineBody, readStdin } from "./_shared/io.js";

interface SendOptions {
  format: MessageFormat;
  metadata?: string;
  agent?: string;
  replyTo?: string;
}

export function registerChatSendCommand(chat: Command): void {
  chat
    .command("send [name] [message]")
    .description(
      "Send a message to an AGENT in the caller's current chat (FIRST_TREE_CHAT_ID). <name> is an agent " +
        "participant; the recipient is @mentioned and woken (must already be a participant — `chat invite` an " +
        "agent first). `chat send` is agent-directed: addressing a human is rejected — put a tracked question to a " +
        "human with `chat ask`, or report progress with `chat update --description`. A message must name a " +
        "recipient — there is no no-mention send.",
    )
    .option("-f, --format <format>", "Message format (text|markdown|card)", "text")
    .option("-m, --metadata <json>", "JSON metadata to attach")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .option(
      "--reply-to <messageId>",
      "Thread a reply under a message — sets inReplyTo (pure threading; does NOT resolve a question)",
    )
    .action(async (name: string | undefined, message: string | undefined, options: SendOptions) => {
      try {
        const chatId = process.env.FIRST_TREE_CHAT_ID;
        if (!chatId) {
          fail(
            "NO_CHAT_CONTEXT",
            "`chat send` must be run from within an agent session that exports FIRST_TREE_CHAT_ID. " +
              "First Tree keeps a single group-chat model — there is no implicit direct chat to fall back to. " +
              "To send from a shell, open the chat in the web UI instead.",
            2,
          );
        }

        // Every send names a recipient: the first positional is the target,
        // the second is the message body.
        const target = name;
        const inlineBody = message;

        if (!target) {
          fail(
            "NO_TARGET",
            "Pass <name> to @mention a recipient — a message must name a recipient (there is no no-mention send).",
            2,
          );
        }

        // Reject an inline body whose newlines are the two-character escape
        // `\n` — shell quotes do not expand it, so the row would render as
        // one long unformatted line. Stdin bodies are never checked: piping
        // is both the fix and the escape hatch for intentional literal `\n`.
        if (inlineBody !== undefined && looksLikeEscapedNewlineBody(inlineBody)) {
          print.line(
            "chat send: the message body arrived with literal \\n escapes — shell quotes do not expand \\n, " +
              "so it would render as one long unformatted line. Resend with real newlines via stdin:\n\n" +
              `  cat <<'EOF' | ${channelConfig.binName} chat send <name> -f markdown\n` +
              "  first line\n" +
              "\n" +
              "  **second** line\n" +
              "  EOF\n\n" +
              "(stdin is not checked — pipe the body if the literal \\n text is intentional.)\n\n",
          );
          fail(
            "ESCAPED_NEWLINES",
            'Inline message body contains literal "\\n" escapes and no real newlines — it would render as one ' +
              "long unformatted line. Resend the body via stdin/heredoc with real newlines (copyable form " +
              "printed above; stdin is not checked, so it also sends intentional literal \\n text).",
            2,
          );
        }

        const content = inlineBody ?? (await readStdin());
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

        // L3: capture any `.md` this message references, exactly like the
        // runtime's result-sink does for final-text — uploading to the org
        // attachment store and attaching generic refs. Pure pass-through
        // outside an agent session.
        const captured = await captureOutboundDocs(content ?? "", { sdk, chatId });
        const outboundMetadata =
          captured.attachments || captured.documentContext
            ? {
                ...(metadata ?? {}),
                ...(captured.attachments ? { attachments: captured.attachments } : {}),
                ...(captured.documentContext ? { documentContext: captured.documentContext } : {}),
              }
            : metadata;

        const result = await sdk.sendMessage(chatId, {
          format: options.format,
          content: captured.content,
          metadata: outboundMetadata,
          source: "cli",
          // Server resolves the name against the chat's participant list and
          // adds it to mentions; an unknown name fails with a `chat invite`
          // hint, and a human recipient is rejected (use `chat ask`).
          ...(target ? { receiverNames: [target] } : {}),
          ...(options.replyTo ? { inReplyTo: options.replyTo } : {}),
        });
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
