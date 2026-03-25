import { execFile } from "node:child_process";
import type { AgentHandler, HandlerFactory } from "../runtime/handler.js";

/**
 * Claude Code Handler — calls the `claude` CLI for each message.
 *
 * Each Handler instance corresponds to a single Session (chat).
 * Currently stateless (one-shot `claude -p`). Multi-turn conversation
 * history management is a future enhancement.
 */
export const createClaudeCodeHandler: HandlerFactory = (_config) => {
  const handler: AgentHandler = {
    async handle(entry, ctx) {
      const message = entry.message;
      const chatId = entry.chatId ?? message.chatId;
      const prompt = typeof message.content === "string" ? message.content : JSON.stringify(message.content);

      ctx.log(`Processing message in chat ${chatId}`);

      const renewInterval = setInterval(() => {
        ctx.sdk.renew(entry.id).catch(() => {});
      }, 60_000);

      try {
        const result = await runClaude(prompt);

        await ctx.sdk.sendMessage(chatId, {
          format: "markdown",
          content: result,
        });

        await ctx.sdk.ack(entry.id);
        ctx.log(`Reply sent, entry ${entry.id} acked`);
      } catch (err) {
        ctx.log(`Handler error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearInterval(renewInterval);
      }
    },

    async shutdown() {
      // No persistent state to clean up in current implementation
    },
  };

  return handler;
};

/** Run `claude -p` and return the text output. */
function runClaude(prompt: string): Promise<string> {
  const bin = process.env.CLAUDE_BIN ?? "claude";
  const args = ["-p", "--output-format", "text", prompt];

  const maxTurns = process.env.CLAUDE_MAX_TURNS;
  if (maxTurns) {
    args.push("--max-turns", maxTurns);
  }

  const model = process.env.CLAUDE_MODEL;
  if (model) {
    args.push("--model", model);
  }

  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`claude exited with code ${error.code}: ${stderr || error.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}
