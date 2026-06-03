import type { MessageFormat } from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { captureOutboundDocs } from "../../core/doc-capture.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { readStdin } from "./_shared/io.js";

interface SendOptions {
  format: MessageFormat;
  metadata?: string;
  agent?: string;
  broadcast?: boolean;
  request?: boolean;
  question?: string;
  option?: string[];
  replyTo?: string;
}

/** Commander collector for a repeatable flag (`--option a --option b`). */
function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerChatSendCommand(chat: Command): void {
  chat
    .command("send [agentName] [message]")
    .description(
      "Send a message into the caller's current chat (FIRST_TREE_CHAT_ID). With <agentName> the recipient is " +
        "@mentioned and woken (must already be a participant — `chat invite` first). With --broadcast the message " +
        "enters the stream but wakes no one. Use --request to ask an open question, --reply-to to answer one.",
    )
    .option("-f, --format <format>", "Message format (text|markdown|card)", "text")
    .option("-m, --metadata <json>", "JSON metadata to attach")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .option("-b, --broadcast", "Send with no @mention — enters the stream, wakes no one")
    .option("--request", "Send as an open question (format=request) directed at <agentName>")
    .option("--question <text>", "The question prompt (with --request)")
    .option("--option <opt>", "An answer option for the question; repeatable (with --request)", collectOption, [])
    .option("--reply-to <messageId>", "Answer/thread this message — sets inReplyTo (clears the asker's red dot)")
    .action(async (agentName: string | undefined, message: string | undefined, options: SendOptions) => {
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

        // Resolve target vs broadcast. In --broadcast mode there is no
        // recipient, so the first positional is actually the message.
        const broadcast = options.broadcast === true;
        const target = broadcast ? undefined : agentName;
        const inlineBody = broadcast ? (message ?? agentName) : message;

        if (!broadcast && !target) {
          fail(
            "NO_TARGET",
            "Pass <agentName> to @mention a recipient, or use --broadcast to send with no @mention " +
              "(enters the stream, wakes no one).",
            2,
          );
        }

        const content = inlineBody ?? (await readStdin());
        const isRequest = options.request === true;
        // A request carries its ask in --question; an empty body is allowed
        // (the question is the actionable part). Every other send needs content.
        if (!content && !(isRequest && options.question)) {
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

        let format: MessageFormat = options.format;
        if (isRequest) {
          if (!target) {
            fail("REQUEST_NEEDS_TARGET", "--request must be directed at a single human <agentName>.", 2);
          }
          if (!options.question) {
            fail("REQUEST_NEEDS_QUESTION", "--request needs --question <text>.", 2);
          }
          const opts = options.option ?? [];
          format = "request";
          metadata = {
            ...(metadata ?? {}),
            request: {
              questions: [
                {
                  id: "q1",
                  prompt: options.question,
                  kind: opts.length > 0 ? "single" : "free",
                  options: opts,
                  required: true,
                },
              ],
            },
          };
        }

        const sdk = createSdk(options.agent);

        // L3: snapshot any `.md` this message references, exactly like the
        // runtime's result-sink does for final-text — closing the biggest
        // doc-preview gap. Pure pass-through outside an agent session.
        const captured = await captureOutboundDocs(content ?? "");
        const outboundMetadata = captured.documentContext
          ? { ...(metadata ?? {}), documentContext: captured.documentContext }
          : metadata;

        const result = await sdk.sendMessage(chatId, {
          format,
          content: captured.content,
          metadata: outboundMetadata,
          source: "cli",
          // Server resolves the name against the chat's participant list and
          // adds it to mentions; an unknown name fails with a `chat invite`
          // hint. Omitted in --broadcast mode → no @mention, no wake-up.
          ...(target ? { receiverNames: [target] } : {}),
          // Answer/thread a prior message; the server's open-question counter
          // decrements off exactly this when the target answers a request.
          ...(options.replyTo ? { inReplyTo: options.replyTo } : {}),
          // Explicit broadcast: enter the stream, wake no one, skip the
          // group-chat @mention guard server-side.
          ...(broadcast ? { broadcast: true } : {}),
        });
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
