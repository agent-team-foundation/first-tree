import type { Command } from "commander";
import { fail, success } from "../cli/output.js";
import { createSdk, handleError } from "../cli/util.js";

const MAX_STDIN_BYTES = 10 * 1024 * 1024; // 10 MB

/** Read all of stdin as a string. Returns null if stdin is a TTY. */
function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    process.stdin.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_STDIN_BYTES) {
        process.stdin.destroy();
        reject(new Error(`stdin exceeds ${MAX_STDIN_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

interface SendOptions {
  format: string;
  chat?: boolean;
  metadata?: string;
  replyTo?: string;
  replyToInbox?: string;
  replyToChat?: string;
}

export function registerSendCommand(program: Command): void {
  program
    .command("send <target> [message]")
    .description("Send a message to an agent or chat")
    .option("-f, --format <format>", "Message format (text|markdown|card)", "text")
    .option("--chat", "Treat target as chat ID instead of agent ID")
    .option("-m, --metadata <json>", "JSON metadata to attach")
    .option("--reply-to <messageId>", "Message ID to reply to")
    .option("--reply-to-inbox <inboxId>", "Cross-chat reply target inbox")
    .option("--reply-to-chat <chatId>", "Cross-chat reply target chat")
    .action(async (target: string, message: string | undefined, options: SendOptions) => {
      try {
        // Resolve message content: argument > stdin > error
        const content = message ?? (await readStdin());
        if (!content) {
          fail("NO_MESSAGE", "No message provided. Pass as argument or pipe via stdin.", 2);
        }

        // Parse metadata if provided
        let metadata: Record<string, unknown> | undefined;
        if (options.metadata) {
          try {
            metadata = JSON.parse(options.metadata) as Record<string, unknown>;
          } catch {
            fail("INVALID_METADATA", "Metadata must be valid JSON.", 2);
          }
        }

        const sdk = createSdk();

        if (options.chat) {
          // Send to existing chat
          const result = await sdk.sendMessage(target, {
            format: options.format,
            content,
            metadata,
            inReplyTo: options.replyTo,
            replyToInbox: options.replyToInbox,
            replyToChat: options.replyToChat,
          });
          success(result);
        } else {
          // Send direct message to agent
          const result = await sdk.sendToAgent(target, {
            format: options.format,
            content,
            metadata,
            replyToInbox: options.replyToInbox,
            replyToChat: options.replyToChat,
          });
          success(result);
        }
      } catch (error) {
        handleError(error);
      }
    });
}
