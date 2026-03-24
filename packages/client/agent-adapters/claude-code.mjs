#!/usr/bin/env node

// Claude Code adapter for Agent Hub Runtime
//
// Bridges the NDJSON protocol to the `claude` CLI.
// Each message is sent to Claude Code in print mode (-p) and the response
// is emitted as a reply.
//
// Usage in agents.yaml:
//   agents:
//     kael:
//       token: ${KAEL_TOKEN}
//       command: node agent-adapters/claude-code.js
//       session:
//         mode: per_chat
//         idle_timeout: 600
//
// Environment variables:
//   CLAUDE_MODEL        — Model to use (optional, e.g. "opus")
//   CLAUDE_MAX_TURNS    — Max agentic turns (optional, default: 10)

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

/** Write a NDJSON line to stdout (back to Runtime). */
function writeLine(data) {
  process.stdout.write(JSON.stringify(data) + "\n");
}

/** Log to stderr (visible in Runtime logs). */
function log(msg) {
  process.stderr.write(`[claude-code] ${msg}\n`);
}

/** Call claude CLI in print mode and return the output. */
async function callClaude(prompt) {
  const args = ["-p", "--output-format", "text"];

  if (process.env.CLAUDE_MODEL) {
    args.push("--model", process.env.CLAUDE_MODEL);
  }
  if (process.env.CLAUDE_MAX_TURNS) {
    args.push("--max-turns", process.env.CLAUDE_MAX_TURNS);
  }

  args.push(prompt);

  return new Promise((resolve, reject) => {
    const cmd = process.env.CLAUDE_BIN || "npx";
    const cmdArgs = cmd.includes("npx") ? ["@anthropic-ai/claude-code", ...args] : args;
    const child = spawn(cmd, cmdArgs, {
      stdio: ["ignore", "pipe", "inherit"],
    });

    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        reject(new Error(`claude exited with code ${code}`));
      }
    });
  });
}

// Signal to Runtime that we are ready
writeLine({ type: "ready" });
log("Ready, waiting for messages...");

for await (const line of rl) {
  if (!line.trim()) continue;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log(`Invalid JSON: ${line}`);
    continue;
  }

  if (msg.type === "shutdown") {
    log("Shutdown received, exiting");
    process.exit(0);
  }

  if (msg.type === "session_init") {
    log(`Session initialized for chat ${msg.chatId}`);
    continue;
  }

  if (msg.type === "message") {
    const content = typeof msg.message.content === "string" ? msg.message.content : JSON.stringify(msg.message.content);

    log(`Processing message ${msg.message.id} from ${msg.message.senderId}`);

    try {
      const reply = await callClaude(content);

      writeLine({
        type: "reply",
        entryId: msg.entryId,
        format: "markdown",
        content: reply,
      });

      log(`Reply sent for entry ${msg.entryId}`);
    } catch (err) {
      log(`Error processing message: ${err.message}`);

      // Send error reply so the message gets acked and the user sees feedback
      writeLine({
        type: "reply",
        entryId: msg.entryId,
        format: "text",
        content: `[Error] Failed to process message: ${err.message}`,
      });
    }
  }
}
