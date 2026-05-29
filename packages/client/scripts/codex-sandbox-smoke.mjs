#!/usr/bin/env node
/**
 * Codex sandbox smoke — verify `danger-full-access` actually unblocks the
 * two motivating scenarios behind PR #647:
 *
 *   T1. `docker ps`                    — host docker socket access works.
 *   T2. write to a path OUTSIDE cwd    — out-of-tree filesystem write works.
 *
 * Runs codex with the same ThreadOptions `buildCodexThreadOptions` would
 * build (sandbox=danger-full-access, approval=never, model unset → CLI auth
 * default), so a green run here is direct evidence the new default behaves
 * as intended on this machine.
 *
 * Usage:
 *   pnpm --filter @first-tree/client smoke:codex-sandbox
 *   # or
 *   node packages/client/scripts/codex-sandbox-smoke.mjs
 *
 * Exit code: 0 = both tasks succeeded; non-zero = any task failed.
 * Stdout streams codex events live so you can watch the agent run.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";

const stamp = Date.now();
const workspaceCwd = mkdtempSync(join(tmpdir(), `codex-smoke-ws-${stamp}-`));
const outOfTreeFile = join(tmpdir(), `codex-smoke-out-of-tree-${stamp}.txt`);
const sentinel = `codex-smoke-${stamp}-OK`;

console.log(`[smoke] workspace cwd        : ${workspaceCwd}`);
console.log(`[smoke] out-of-tree target   : ${outOfTreeFile}`);
console.log(`[smoke] sentinel             : ${sentinel}`);
console.log();

const codex = new Codex();
const thread = codex.startThread({
  workingDirectory: workspaceCwd,
  skipGitRepoCheck: true,
  sandboxMode: "danger-full-access",
  approvalPolicy: "never",
  modelReasoningEffort: "high",
  webSearchEnabled: false,
});

const prompt = [
  "You are a sandbox smoke test. Perform these two steps in order and stop.",
  "",
  `Step 1 (T1 — docker socket access): run \`docker ps\` exactly once and report whether the command exited 0.`,
  "If it errors with a permission/socket error, report the full error.",
  "",
  `Step 2 (T2 — out-of-tree write): write the literal string "${sentinel}" to the absolute path`,
  `\`${outOfTreeFile}\` (NOT inside the working directory). Use \`/bin/sh -c\` if needed.`,
  "Report whether the write succeeded.",
  "",
  "Final line of your reply MUST be exactly one of:",
  "  RESULT: T1=ok T2=ok",
  "  RESULT: T1=ok T2=fail",
  "  RESULT: T1=fail T2=ok",
  "  RESULT: T1=fail T2=fail",
].join("\n");

console.log("[smoke] launching codex…\n");

const { events } = await thread.runStreamed(prompt);
let lastMessage = "";

for await (const ev of events) {
  switch (ev.type) {
    case "thread.started":
      console.log(`[event] thread.started id=${ev.thread_id}`);
      break;
    case "turn.started":
      console.log(`[event] turn.started`);
      break;
    case "item.started":
    case "item.updated":
      // Skip noise; only print completed items.
      break;
    case "item.completed": {
      const item = ev.item;
      if (item.type === "command_execution") {
        console.log(`[cmd  ] $ ${item.command}`);
        if (item.aggregated_output) {
          const out = item.aggregated_output.trim();
          console.log(
            out
              .split("\n")
              .map((l) => `         ${l}`)
              .join("\n"),
          );
        }
        console.log(`[cmd  ] exit=${item.exit_code} status=${item.status}`);
      } else if (item.type === "agent_message") {
        lastMessage = item.text;
        console.log(`[msg  ] ${item.text}`);
      } else if (item.type === "file_change") {
        console.log(`[file ] ${item.status}: ${item.changes.map((c) => `${c.kind} ${c.path}`).join(", ")}`);
      } else if (item.type === "error") {
        console.log(`[error] ${item.message}`);
      }
      break;
    }
    case "turn.completed":
      console.log(`[event] turn.completed`);
      break;
    case "turn.failed":
      console.log(`[event] turn.failed: ${ev.error?.message ?? "(no message)"}`);
      break;
    case "thread.error":
      console.log(`[event] thread.error: ${ev.error?.message ?? "(no message)"}`);
      break;
    default:
      // ignore reasoning/web_search/todo_list noise
      break;
  }
}

console.log();
console.log("[smoke] verifying side effects…");

const t2Wrote = existsSync(outOfTreeFile);
let t2Contains = false;
if (t2Wrote) {
  const body = readFileSync(outOfTreeFile, "utf8");
  t2Contains = body.includes(sentinel);
  console.log(`[smoke] out-of-tree file exists, contains sentinel: ${t2Contains}`);
} else {
  console.log(`[smoke] out-of-tree file MISSING`);
}

const resultLine = (lastMessage.match(/^RESULT: T1=(\w+) T2=(\w+)$/m) ?? []).slice(1);
const t1Claim = resultLine[0] ?? "unknown";
const t2Claim = resultLine[1] ?? "unknown";

const t1Pass = t1Claim === "ok";
const t2Pass = t2Wrote && t2Contains;

console.log();
console.log("─".repeat(60));
console.log(`T1 (docker ps)           : ${t1Pass ? "PASS" : "FAIL"}   (agent claim: ${t1Claim})`);
console.log(
  `T2 (out-of-tree write)   : ${t2Pass ? "PASS" : "FAIL"}   (agent claim: ${t2Claim}, file ok: ${t2Wrote && t2Contains})`,
);
console.log("─".repeat(60));

// Best-effort cleanup; leave on failure for inspection.
if (t1Pass && t2Pass) {
  try {
    rmSync(workspaceCwd, { recursive: true, force: true });
    rmSync(outOfTreeFile, { force: true });
  } catch {}
}

process.exit(t1Pass && t2Pass ? 0 : 1);
