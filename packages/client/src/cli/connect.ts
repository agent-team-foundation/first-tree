import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { InboxEntryWithMessage } from "@agent-hub/shared";
import type { Command } from "commander";
import { AgentConnection } from "../connection.js";
import { toInboundMessage, toMessageFormat } from "../runtime/convert.js";
import type { AgentOutput } from "../runtime/protocol.js";
import { agentOutputSchema } from "../runtime/protocol.js";
import { handleError, log, resolveConfig } from "./util.js";

/** Write a NDJSON line to stdout. */
function writeLine(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

// ---------------------------------------------------------------------------
// Pipe mode: stdin/stdout NDJSON
// ---------------------------------------------------------------------------

async function runPipeMode(conn: AgentConnection): Promise<void> {
  conn.onMessage(async (entry) => {
    writeLine(toInboundMessage(entry));
    // Auto-ack in pipe mode (agent can override via stdin ack)
    try {
      await conn.sdk.ack(entry.id);
    } catch (err) {
      log("connect", `Failed to ack entry ${entry.id}: ${err instanceof Error ? err.message : err}`);
    }
  });

  // Read stdin for agent responses
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const parsed = agentOutputSchema.parse(JSON.parse(line));
      await handleAgentOutput(conn, parsed);
    } catch (err) {
      log("connect", `Invalid stdin message: ${err instanceof Error ? err.message : err}`);
    }
  });
}

async function handleAgentOutput(conn: AgentConnection, msg: AgentOutput): Promise<void> {
  switch (msg.type) {
    case "reply": {
      const chatId = msg.entryId.toString(); // will be resolved in Phase 2
      await conn.sdk.sendMessage(chatId, {
        format: toMessageFormat(msg.format),
        content: msg.content,
      });
      break;
    }
    case "send": {
      if (msg.to.chatId) {
        await conn.sdk.sendMessage(msg.to.chatId, {
          format: toMessageFormat(msg.format),
          content: msg.content,
        });
      } else if (msg.to.agentId) {
        await conn.sdk.sendToAgent(msg.to.agentId, {
          format: toMessageFormat(msg.format),
          content: msg.content,
        });
      }
      break;
    }
    case "ack":
      await conn.sdk.ack(msg.entryId);
      break;
    case "renew":
      await conn.sdk.renew(msg.entryId);
      break;
    case "ready":
      // no-op in pipe mode
      break;
  }
}

// ---------------------------------------------------------------------------
// Exec mode: spawn subprocess per message
// ---------------------------------------------------------------------------

async function runExecMode(conn: AgentConnection, command: string, concurrency: number): Promise<void> {
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (active < concurrency) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        active++;
        resolve();
      });
    });
  };

  const release = (): void => {
    active--;
    const next = waiters.shift();
    if (next) next();
  };

  conn.onMessage(async (entry) => {
    await acquire();
    try {
      await handleMessageExec(conn, entry, command);
    } finally {
      release();
    }
  });
}

async function handleMessageExec(conn: AgentConnection, entry: InboxEntryWithMessage, command: string): Promise<void> {
  const inbound = toInboundMessage(entry);
  const chatId = inbound.chatId;

  return new Promise<void>((resolve) => {
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "inherit"] });

    let stdout = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.on("error", (err) => {
      log("connect", `Exec error for entry ${entry.id}: ${err.message}`);
      resolve();
    });

    child.on("close", async (code) => {
      if (code === 0) {
        // Try to parse stdout lines for replies
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = agentOutputSchema.parse(JSON.parse(line));
            if (parsed.type === "reply") {
              log("connect", `Sending reply for entry ${parsed.entryId} to chat ${chatId}`);
              try {
                await conn.sdk.sendMessage(chatId, {
                  format: toMessageFormat(parsed.format),
                  content: parsed.content,
                });
                log("connect", `Reply sent for entry ${parsed.entryId}`);
              } catch (sendErr) {
                log("connect", `Failed to send reply: ${sendErr instanceof Error ? sendErr.message : sendErr}`);
              }
            }
          } catch {
            // Not valid protocol JSON — ignore
          }
        }
        try {
          await conn.sdk.ack(entry.id);
          log("connect", `Entry ${entry.id} acked`);
        } catch (err) {
          log("connect", `Failed to ack entry ${entry.id}: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        log("connect", `Process exited with code ${code} for entry ${entry.id}, leaving un-acked`);
      }
      resolve();
    });

    // Write message to child stdin and close
    child.stdin.write(`${JSON.stringify(inbound)}\n`);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerConnectCommand(program: Command): void {
  program
    .command("connect")
    .description("Connect to server and process messages in real-time")
    .option("--exec <command>", "Spawn a subprocess for each message")
    .option("--concurrency <n>", "Max parallel message processing", "5")
    .option("--server <url>", "Override AGENT_HUB_SERVER")
    .action(async (options: { exec?: string; concurrency: string; server?: string }) => {
      try {
        const config = resolveConfig();
        if (options.server) {
          config.serverUrl = options.server;
        }

        const conn = new AgentConnection({
          serverUrl: config.serverUrl,
          token: config.token,
        });

        // Lifecycle logging
        conn.on("connected", () => log("connect", "Connected"));
        conn.on("reconnecting", (attempt) => log("connect", `Reconnecting (attempt ${attempt})...`));
        conn.on("error", (err) => log("connect", `Error: ${err.message}`));

        const agent = await conn.connect();
        log("connect", `Registered as ${agent.displayName ?? agent.agentId} (${agent.agentId})`);
        writeLine({ type: "connected", agent });

        if (options.exec) {
          const concurrency = Number.parseInt(options.concurrency, 10) || 5;
          await runExecMode(conn, options.exec, concurrency);
        } else {
          await runPipeMode(conn);
        }

        // Graceful shutdown
        const shutdown = async () => {
          log("connect", "Shutting down...");
          await conn.disconnect();
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      } catch (error) {
        handleError(error);
      }
    });
}
