import { randomUUID } from "node:crypto";
import { SdkError } from "@first-tree/client";
import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import { captureOutboundDocs } from "../../core/doc-capture.js";
import { isJsonMode, print } from "../../core/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { readStdin } from "./_shared/io.js";

type ChatCreateFormat = "text" | "markdown";

const UNKNOWN_COMMIT_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
]);

type CreateOptions = {
  to: string[];
  with: string[];
  message?: string;
  format: string;
  topic?: string;
  operationId?: string;
  agent?: string;
};

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseFormat(value: string): ChatCreateFormat {
  if (value === "text" || value === "markdown") return value;
  fail("CHAT_CREATE_INVALID_FORMAT", "Message format must be text or markdown.", 2, {
    details: { option: "--format", input: value, hint: "Use --format text or --format markdown." },
  });
}

function assertNoDuplicateSelectors(to: ReadonlyArray<string>, withTargets: ReadonlyArray<string>): void {
  const seen = new Map<string, { option: "--to" | "--with"; input: string }>();
  for (const [option, values] of [
    ["--to", to],
    ["--with", withTargets],
  ] as const) {
    for (const input of values) {
      const existing = seen.get(input);
      if (existing) {
        fail("CHAT_CREATE_DUPLICATE_TARGET", `Duplicate target "${input}" passed to chat create.`, 2, {
          details: {
            targets: [existing, { option, input }],
            hint: "A target may appear in --to or --with, but not both and not more than once.",
          },
        });
      }
      seen.set(input, { option, input });
    }
  }
}

function failUnknownCommitStatus(operationId: string, cause: unknown): never {
  const message = cause instanceof Error ? cause.message : String(cause);
  fail("CHAT_CREATE_UNKNOWN_COMMIT_STATUS", "Unable to confirm whether chat create committed.", 1, {
    details: {
      operationId,
      cause: message,
      hint: `Retry with --operation-id ${operationId}; if the first request committed, the server will return the same chat/message instead of creating a duplicate.`,
    },
  });
}

function isUnknownCommitNetworkError(error: unknown): boolean {
  let current: unknown = error;
  let depth = 0;
  while (current !== null && current !== undefined && depth < 5) {
    if (typeof current !== "object") return false;
    const obj = current as { message?: unknown; name?: unknown; code?: unknown; cause?: unknown };
    if (typeof obj.message === "string" && obj.message.includes("fetch failed")) return true;
    if (obj.name === "AbortError" || obj.name === "TimeoutError") return true;
    if (typeof obj.code === "string" && UNKNOWN_COMMIT_NETWORK_CODES.has(obj.code)) return true;
    current = obj.cause;
    depth++;
  }
  return false;
}

function renderHumanResult(result: {
  chat: { id: string };
  message: { id: string };
  operationId: string;
  replayed: boolean;
  senderAgentId: string;
  recipientAgentIds: string[];
  participantAgentIds: string[];
}): void {
  const recipientSet = new Set(result.recipientAgentIds);
  const extraParticipants = result.participantAgentIds.filter(
    (id) => id !== result.senderAgentId && !recipientSet.has(id),
  );
  print.line(`Chat ${result.replayed ? "replayed" : "created"}: ${result.chat.id}\n`);
  print.line(`  Sender: ${result.senderAgentId}\n`);
  print.line(`  Recipients: ${result.recipientAgentIds.join(", ")}\n`);
  print.line(`  Extra participants: ${extraParticipants.length > 0 ? extraParticipants.join(", ") : "(none)"}\n`);
  print.line(`  Message: ${result.message.id}\n`);
  print.line(`  Operation: ${result.operationId}\n`);
  print.line("  Current session unchanged.\n");
}

export function registerChatCreateCommand(chat: Command): void {
  chat
    .command("create")
    .description(
      "Start a new task chat and send the first message. --to is the first-message recipient; --with adds context-only participants. The current FIRST_TREE_CHAT_ID is not changed.",
    )
    .option("--to <name-or-uuid>", "Recipient for the first message; repeatable", collectOption, [])
    .option(
      "--with <name-or-uuid>",
      "Extra participant that is not woken by the first message; repeatable",
      collectOption,
      [],
    )
    .option("--message <text>", "First message body; omitted means read from stdin when piped")
    .option("-f, --format <format>", "Message format (text|markdown)", "text")
    .option("--topic <text>", "Topic for the new chat")
    .option("--operation-id <id>", "Idempotency key to reuse after unknown commit status")
    .option("--agent <name>", "Agent name on the First Tree server (default: current or only configured agent)")
    .action(async (options: CreateOptions) => {
      const operationId = options.operationId ?? randomUUID();
      try {
        const to = options.to ?? [];
        const withTargets = options.with ?? [];
        if (to.length === 0) {
          fail("CHAT_CREATE_MISSING_TO", "`chat create` requires at least one --to target.", 2, {
            details: { option: "--to", hint: "Pass --to <agent-name-or-id> for each first-message recipient." },
          });
        }
        assertNoDuplicateSelectors(to, withTargets);
        if (operationId.trim().length === 0) {
          fail("CHAT_CREATE_EMPTY_OPERATION_ID", "--operation-id must not be empty.", 2, {
            details: { option: "--operation-id", hint: "Omit --operation-id to generate one automatically." },
          });
        }
        const format = parseFormat(options.format);
        const content = options.message ?? (await readStdin());
        if (content === null || content.trim().length === 0) {
          fail("CHAT_CREATE_EMPTY_MESSAGE", "`chat create` requires a non-empty message.", 2, {
            details: { option: "--message", hint: "Pass --message <text> or pipe non-empty stdin." },
          });
        }

        const captured = await captureOutboundDocs(content);
        const sdk = createSdk(options.agent);
        const result = await sdk.createChatWithInitialMessage({
          operationId,
          to,
          with: withTargets,
          topic: options.topic,
          message: {
            format,
            content: captured.content,
            source: "cli",
            ...(captured.documentContext ? { metadata: { documentContext: captured.documentContext } } : {}),
          },
        });

        if (isJsonMode()) {
          print.result(result);
        } else {
          renderHumanResult(result);
        }
      } catch (error) {
        if (error instanceof SdkError && error.statusCode >= 500) {
          failUnknownCommitStatus(operationId, error);
        }
        if (isUnknownCommitNetworkError(error)) {
          failUnknownCommitStatus(operationId, error);
        }
        handleSdkError(error);
      }
    });
}
