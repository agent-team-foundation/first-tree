import type { MessageFormat } from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { channelConfig } from "../../core/channel.js";
import { captureOutboundDocs } from "../../core/doc-capture.js";
import { print } from "../../core/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { looksLikeEscapedNewlineBody, readStdin } from "./_shared/io.js";
import { buildRequestMetadata } from "./_shared/request.js";

interface AskOptions {
  format: MessageFormat;
  metadata?: string;
  agent?: string;
  options?: string;
  multiSelect?: boolean;
}

export function registerChatAskCommand(chat: Command): void {
  chat
    .command("ask [name] [message]")
    .description(
      "Ask a HUMAN in the caller's current chat (FIRST_TREE_CHAT_ID) a tracked question — a decision, approval, or " +
        "answer. Writes an open question (format=request) directed at a single human <name>: the message body IS " +
        "the ask (background + question). Omit --options for a free-text answer, or pass 2–4 --options for a " +
        "choice. Raises a tracked red dot and blocks the chat for them until they answer. The human resolves it " +
        "in the web UI — an agent can only ASK; it cannot answer or close a question.",
    )
    .option("-f, --format <format>", "Message format (text|markdown|card)", "text")
    .option("-m, --metadata <json>", "JSON metadata to attach")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .option(
      "--options <json>",
      "Answer options as a JSON array, 2–4 items of {label (1–5 words), description, preview?}. e.g. " +
        `'[{"label":"Ship","description":"Roll to 20% now"},{"label":"Hold","description":"Wait 24h"}]'`,
    )
    .option("--multi-select", "Allow picking more than one option (requires --options)")
    .action(async (name: string | undefined, message: string | undefined, options: AskOptions) => {
      try {
        const chatId = process.env.FIRST_TREE_CHAT_ID;
        if (!chatId) {
          fail(
            "NO_CHAT_CONTEXT",
            "`chat ask` must be run from within an agent session that exports FIRST_TREE_CHAT_ID. " +
              "To ask from a shell, open the chat in the web UI instead.",
            2,
          );
        }

        const target = name;
        const inlineBody = message;

        if (!target) {
          fail("NO_TARGET", "Pass <name> to direct the question at a single human member.", 2);
        }

        // Reject an inline body whose newlines are the two-character escape
        // `\n` — shell quotes do not expand it, so the row would render as one
        // long unformatted line. Stdin bodies are never checked.
        if (inlineBody !== undefined && looksLikeEscapedNewlineBody(inlineBody)) {
          print.line(
            "chat ask: the message body arrived with literal \\n escapes — shell quotes do not expand \\n, " +
              "so it would render as one long unformatted line. Resend with real newlines via stdin:\n\n" +
              `  cat <<'EOF' | ${channelConfig.binName} chat ask <name> -f markdown\n` +
              "  background / context line\n" +
              "  EOF\n\n" +
              "(stdin is not checked — pipe the body if the literal \\n text is intentional.)\n\n",
          );
          fail(
            "ESCAPED_NEWLINES",
            'Inline message body contains literal "\\n" escapes and no real newlines — it would render as one ' +
              "long unformatted line. Resend the body via stdin/heredoc with real newlines.",
            2,
          );
        }

        const content = inlineBody ?? (await readStdin());

        let metadata: Record<string, unknown> | undefined;
        if (options.metadata) {
          try {
            metadata = JSON.parse(options.metadata) as Record<string, unknown>;
          } catch {
            fail("INVALID_METADATA", "Metadata must be valid JSON.", 2);
          }
        }

        // `chat ask` only ASKS. The body IS the ask (background + question);
        // `--options` (2–4) adds a choice, omit them for a free-text answer.
        // There is no resolve path here — the human answers in the web UI; an
        // agent cannot mark a question answered or close it.
        if (!content) {
          fail(
            "ASK_NEEDS_BODY",
            "`chat ask` needs a message body — the body is the ask (background + question). " +
              "Pass it as an argument or via stdin.",
            2,
          );
        }
        const format: MessageFormat = "request";
        metadata = buildRequestMetadata(metadata, options);

        const sdk = createSdk(options.agent);

        const captured = await captureOutboundDocs(content ?? "", { sdk, chatId });
        const outboundMetadata =
          captured.attachments || captured.documentContext
            ? {
                ...(metadata ?? {}),
                ...(captured.attachments ? { attachments: captured.attachments } : {}),
                ...(captured.documentContext ? { documentContext: captured.documentContext } : {}),
              }
            : metadata;

        // `chat ask` always opens a fresh top-level question; it does not thread
        // under another message (no `inReplyTo`).
        const result = await sdk.sendMessage(chatId, {
          format,
          content: captured.content,
          metadata: outboundMetadata,
          source: "cli",
          ...(target ? { receiverNames: [target] } : {}),
        });
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
