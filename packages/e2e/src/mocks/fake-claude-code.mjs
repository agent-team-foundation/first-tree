#!/usr/bin/env node
// Fake `claude-code` binary for e2e — pretends to be the upstream native
// binary the Claude Agent SDK spawns. Speaks the stream-json protocol over
// stdin/stdout exactly enough to make the SDK's `query()` return at least
// one assistant message + a `result` terminator per user input.
//
// Protocol summary (see `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
// for the authoritative type defs):
//
//   - SDK invokes with `--input-format stream-json --output-format stream-json
//     --print --verbose ...` plus a session id and many other flags. We
//     accept any flags, ignore the ones we don't care about, and read
//     `--session-id` to thread it into our responses (the SDK pins
//     `session_id` on every emitted message).
//   - stdin: one JSON SDKUserMessage per line:
//       { type: "user", message: { role: "user", content: <string|array> }, ... }
//   - stdout: one JSON SDKMessage per line. The minimum the SDK accepts for
//     the e2e contract:
//       1. First line: { type: "system", subtype: "init", ... session metadata ... }
//       2. For each user line:
//          { type: "assistant", message: { id, type: "message", role: "assistant",
//            content: [{type: "text", text: <echo|canned>}], model, ... }, ... }
//          { type: "result", subtype: "success", duration_ms: 0, ... result: <text>, ... }
//   - Exit when stdin closes (the SDK's `close()` ends the input stream).
//
// The output env knobs let tests override the canned response without
// rebuilding the binary:
//   FAKE_CLAUDE_REPLY  — fixed string the assistant says back (default echoes the input)
//   FAKE_CLAUDE_DELAY_MS — pre-emit delay, useful for testing timeout paths
//
// Failure-mode env knobs:
//   FAKE_CLAUDE_FAIL_INIT=1 — exit 1 before emitting init (simulates a broken binary)
//   FAKE_CLAUDE_FAIL_TURN=1 — emit a `result` with `is_error: true` instead of `success`

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
function readFlag(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const sessionId = readFlag("--session-id") ?? randomUUID();
const model = readFlag("--model") ?? "claude-fake-e2e";
const cwd = process.cwd();
const replyTemplate = process.env.FAKE_CLAUDE_REPLY ?? null;
const delayMs = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? "0");

function writeLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

function extractUserText(msg) {
  if (!msg || typeof msg !== "object") return "";
  const content = msg.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

async function main() {
  if (process.env.FAKE_CLAUDE_FAIL_INIT === "1") {
    process.stderr.write("fake-claude-code: forced init failure\n");
    process.exit(1);
  }

  await sleep(delayMs);

  // init system message
  writeLine({
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: "0.0.0-fake-e2e",
    cwd,
    tools: [],
    mcp_servers: [],
    model,
    permissionMode: "bypassPermissions",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: randomUUID(),
    session_id: sessionId,
  });

  const rl = createInterface({ input: process.stdin });

  let turn = 0;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`fake-claude-code: malformed stdin line ignored: ${trimmed}\n`);
      continue;
    }
    // Only react to actual user messages. The SDK may also send control
    // messages on stdin (cancel, settings push) which we silently drop.
    if (!parsed || parsed.type !== "user") continue;

    turn += 1;
    const userText = extractUserText(parsed);
    const replyText = replyTemplate ?? `fake-claude-code echo (turn ${turn}): ${userText}`;
    const assistantUuid = randomUUID();

    writeLine({
      type: "assistant",
      message: {
        id: `msg_${randomUUID().replace(/-/g, "")}`,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: replyText }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      uuid: assistantUuid,
      session_id: sessionId,
    });

    const isErr = process.env.FAKE_CLAUDE_FAIL_TURN === "1";
    writeLine({
      type: "result",
      subtype: isErr ? "error_during_execution" : "success",
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: isErr,
      num_turns: turn,
      result: replyText,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: sessionId,
    });
  }
}

main().catch((err) => {
  process.stderr.write(`fake-claude-code: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(2);
});
