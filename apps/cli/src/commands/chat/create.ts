import { SdkError } from "@first-tree/client";
import type { MessageFormat } from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { captureOutboundDocs } from "../../core/doc-capture.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { readStdin } from "./_shared/io.js";

interface CreateOptions {
  to: string[];
  with?: string[];
  topic?: string;
  description?: string;
  format: MessageFormat;
  metadata?: string;
  agent?: string;
  request?: boolean;
  question?: string;
  option?: string[];
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function handleCreateError(error: unknown): never {
  if (error instanceof SdkError && error.statusCode >= 500) {
    fail(
      "CREATE_RESULT_UNKNOWN",
      "The server returned an error after the create request was sent. The chat may already exist. " +
        "Check `chat list` or the Web UI before running `chat create` again; this command is not idempotent.",
      6,
    );
  }
  if (isUncertainNetworkError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    fail(
      "CREATE_RESULT_UNKNOWN",
      `The create request result is unknown (${message}). The chat may already exist. ` +
        "Check `chat list` or the Web UI before running `chat create` again; this command is not idempotent.",
      6,
    );
  }
  handleSdkError(error);
}

function isUncertainNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  if (error instanceof TypeError && "cause" in error) return true;
  let current: unknown = "cause" in error ? error.cause : undefined;
  let depth = 0;
  while (current && typeof current === "object" && depth < 5) {
    const obj = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (obj.name === "AbortError" || obj.name === "TimeoutError") return true;
    if (
      typeof obj.code === "string" &&
      ["ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(obj.code)
    ) {
      return true;
    }
    current = obj.cause;
    depth++;
  }
  return false;
}

function parseFormat(value: string): MessageFormat {
  if (value === "text" || value === "markdown" || value === "card") {
    return value;
  }
  fail("INVALID_FORMAT", "Format must be one of: text, markdown, card.", 2);
}

export function registerChatCreateCommand(chat: Command): void {
  chat
    .command("create [message]")
    .description(
      "Create a separate task chat and send its first message. --to recipients are mentioned and woken; --with " +
        "participants are added for context without being woken by the first message. This command does not create " +
        "empty chats and is not idempotent. For same-task agent handoffs, use `chat invite` in the current chat.",
    )
    .requiredOption("--to <name>", "Initial recipient to @mention and wake; repeatable", collect, [])
    .option("--with <name>", "Context participant to add without waking on the first message; repeatable", collect, [])
    .option("--topic <text>", "Stable chat topic")
    .option("--description <text>", "Current-state chat description")
    .option("-f, --format <format>", "Initial message format (text|markdown|card)", "text")
    .option("-m, --metadata <json>", "JSON metadata to attach; routing/provenance keys are controlled by the server")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .option(
      "--request",
      "Create the task with an open question. Requires exactly one --to recipient; the message body is context.",
    )
    .option("--question <text>", "The question prompt — just the ask, no background (with --request)")
    .option("--option <opt>", "An answer option for the question; repeatable (with --request)", collect, [])
    .action(async (message: string | undefined, options: CreateOptions) => {
      try {
        const to = options.to ?? [];
        if (to.length === 0) {
          fail("NO_TARGET", "Pass at least one --to <name> recipient.", 2);
        }

        const content = message ?? (await readStdin());
        if (!content || content.trim().length === 0) {
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

        let format = parseFormat(options.format);
        if (options.request === true) {
          if (to.length !== 1) {
            fail("REQUEST_NEEDS_ONE_TARGET", "--request task creation requires exactly one --to recipient.", 2);
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
        const captured = await captureOutboundDocs(content);
        const outboundMetadata = captured.documentContext
          ? { ...(metadata ?? {}), documentContext: captured.documentContext }
          : metadata;
        const result = await sdk.createTaskChat({
          mode: "task",
          initialRecipientAgentIds: [],
          initialRecipientNames: to,
          contextParticipantAgentIds: [],
          contextParticipantNames: options.with ?? [],
          ...(options.topic ? { topic: options.topic } : {}),
          ...(options.description ? { description: options.description } : {}),
          initialMessage: {
            format,
            content: captured.content,
            ...(outboundMetadata ? { metadata: outboundMetadata } : {}),
            source: "cli",
          },
        });
        success(result);
      } catch (error) {
        handleCreateError(error);
      }
    });
}
