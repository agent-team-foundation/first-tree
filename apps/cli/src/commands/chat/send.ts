import type { MessageFormat } from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { captureOutboundDocs } from "../../core/doc-capture.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { readStdin } from "./_shared/io.js";
import { buildRequestMetadata } from "./_shared/request.js";

interface SendOptions {
  format: MessageFormat;
  metadata?: string;
  agent?: string;
  request?: boolean;
  subject?: string;
  question?: string;
  option?: string[];
  replyTo?: string;
  answer?: string;
  close?: string;
}

/** Commander collector for a repeatable flag (`--option a --option b`). */
function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerChatSendCommand(chat: Command): void {
  chat
    .command("send [name] [message]")
    .description(
      "Send a message into the caller's current chat (FIRST_TREE_CHAT_ID). <name> is any participant — agent or " +
        "human; the recipient is @mentioned and woken (must already be a participant — `chat invite` an agent " +
        "first). A message must name a recipient — there is no no-mention send. Use --request to ask a human an " +
        "open question, and --answer/--close to resolve a question you asked.",
    )
    .option("-f, --format <format>", "Message format (text|markdown|card)", "text")
    .option("-m, --metadata <json>", "JSON metadata to attach")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .option(
      "--request",
      "Send as an open question (format=request) directed at a single human <name>. The message body carries the " +
        "background/context; --question carries only the ask",
    )
    .option(
      "--subject <text>",
      "Short headline for the request, shown in the answer dock/card header (with --request, ≤80 chars)",
    )
    .option("--question <text>", "The question prompt — just the ask, no background (with --request, ≤200 chars)")
    .option("--option <opt>", "An answer option for the question; repeatable (with --request)", collectOption, [])
    .option(
      "--answer <requestId>",
      "Resolve an open question you asked: mark it answered and clear the human's red dot. The message body is " +
        "the confirmed answer. Threads under the question.",
    )
    .option(
      "--close <requestId>",
      "Withdraw an open question you asked: mark it closed and clear the human's red dot. The message body is the " +
        "reason. Re-asking opens a NEW question — it never auto-supersedes, so close the stale one explicitly.",
    )
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

        const content = inlineBody ?? (await readStdin());
        const isRequest = options.request === true;
        // Every send needs a body. For a request the split is: the body carries
        // the background/context (rendered as the card's markdown body), and
        // --question carries ONLY the ask. Allowing an empty body let agents
        // cram the whole context into --question, leaving the card bodyless.
        if (!content && isRequest) {
          fail(
            "REQUEST_NEEDS_BODY",
            "--request still needs a message body: put the background/context in the body " +
              "(argument or stdin) and keep --question to just the ask.",
            2,
          );
        }
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

        let format: MessageFormat = options.format;
        if (isRequest) {
          if (!target) {
            fail("REQUEST_NEEDS_TARGET", "--request must be directed at a single human member.", 2);
          }
          format = "request";
          metadata = buildRequestMetadata(metadata, options);
        }

        // --answer / --close fold open-question resolution into `send`: they
        // attach `metadata.resolves` (the explicit signal the server's red-dot
        // −1 keys off) and thread the reply under the question. `inReplyTo`
        // alone never resolves anything — it is pure threading now.
        const resolveId = options.answer ?? options.close;
        if (resolveId !== undefined) {
          if (isRequest) {
            fail("RESOLVE_WITH_REQUEST", "--answer/--close cannot be combined with --request.", 2);
          }
          if (options.answer && options.close) {
            fail("RESOLVE_AMBIGUOUS", "Pass only one of --answer / --close.", 2);
          }
          const kind = options.answer ? "answered" : "closed";
          metadata = {
            ...(metadata ?? {}),
            // For a withdrawal the body doubles as the human-readable reason.
            resolves: { request: resolveId, kind, ...(kind === "closed" && content ? { reason: content } : {}) },
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

        // `--reply-to` threads explicitly; `--answer`/`--close` thread under the
        // question they resolve. Either way `inReplyTo` is pure threading.
        const inReplyTo = options.replyTo ?? resolveId;

        const result = await sdk.sendMessage(chatId, {
          format,
          content: captured.content,
          metadata: outboundMetadata,
          source: "cli",
          // Server resolves the name against the chat's participant list and
          // adds it to mentions; an unknown name fails with a `chat invite`
          // hint.
          ...(target ? { receiverNames: [target] } : {}),
          ...(inReplyTo ? { inReplyTo } : {}),
        });
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
