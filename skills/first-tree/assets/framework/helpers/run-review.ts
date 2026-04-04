#!/usr/bin/env node
/**
 * Run Claude Code review and extract structured JSON output.
 *
 * Builds the review prompt, invokes Claude Code with stream-json output,
 * extracts text from the stream, parses the review JSON, and retries up
 * to 3 times on failure. Writes the validated review JSON to /tmp/review.json.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE_BIN = join(homedir(), ".local", "bin", "claude");
const MAX_ATTEMPTS = 3;
// Per-invocation budget cap. Worst case is $1.50 total (3 × $0.50),
// though retries are cheap in practice due to cached context via --continue.
const MAX_BUDGET_USD = 0.5;
const AGENT_INSTRUCTIONS_PATHS = ["AGENTS.md", "AGENT.md"] as const;

function resolveAgentInstructionsPath(): string {
  for (const candidate of AGENT_INSTRUCTIONS_PATHS) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Missing AGENTS.md in repo root (legacy AGENT.md is also accepted during migration).",
  );
}

function buildPrompt(diffPath: string): string {
  const parts: string[] = [];
  const agentInstructionsPath = resolveAgentInstructionsPath();
  const files: [string, string][] = [
    [agentInstructionsPath, agentInstructionsPath],
    ["Root NODE.md", "NODE.md"],
    [
      "Review Instructions",
      ".agents/skills/first-tree/assets/framework/prompts/pr-review.md",
    ],
  ];
  for (const [heading, path] of files) {
    const content = readFileSync(path, "utf-8");
    parts.push(`## ${heading}\n\n${content}`);
  }
  const diff = readFileSync(diffPath, "utf-8");
  parts.push(`## PR Diff\n\n\`\`\`\n${diff}\`\`\``);
  return parts.join("\n\n");
}

export function extractStreamText(jsonl: string): string {
  const textParts: string[] = [];
  let resultText = "";
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (msg.type === "assistant") {
      const message = msg.message as Record<string, unknown> | undefined;
      const content = message?.content as Array<Record<string, unknown>> | undefined;
      if (content) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          }
        }
      }
    }
    if (msg.type === "result") {
      const r = msg.result;
      if (typeof r === "string" && r) {
        resultText = r;
      }
    }
  }
  // Prefer assistant text blocks; fall back to result field
  return textParts.length > 0 ? textParts.join("") : resultText;
}

function runClaude(opts: { prompt?: string; continueSession?: boolean }): string {
  const cmd = [
    "-p",
    "--dangerously-skip-permissions",
    "--output-format", "stream-json",
    "--verbose",
    "--max-budget-usd", String(MAX_BUDGET_USD),
  ];
  if (opts.continueSession) {
    cmd.push("--continue");
  }

  try {
    const stdout = execFileSync(CLAUDE_BIN, cmd, {
      input: opts.prompt,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "inherit"],
      maxBuffer: 50 * 1024 * 1024,
    });
    return extractStreamText(stdout);
  } catch (err: unknown) {
    const code = (err as { status?: number }).status ?? 1;
    console.error(`::error::Claude exited with code ${code}`);
    process.exit(1);
  }
}

export interface Review {
  verdict: string;
  summary?: string;
  inline_comments?: Array<{ file: string; line: number; comment: string }>;
}

export function extractReviewJson(text: string): Review | null {
  if (!text.trim()) return null;
  // Strip markdown fences
  let cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "");
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!obj.verdict) return null;
  return obj as unknown as Review;
}

function main(): void {
  const prompt = buildPrompt("/tmp/pr-diff.txt");
  console.log(`=== Prompt size: ${Buffer.byteLength(prompt)} bytes ===`);

  let text = runClaude({ prompt });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (text.trim()) {
      console.log(`=== Attempt ${attempt}: Raw output ===`);
      console.log(text);
      console.log("=== End raw output ===");
    } else {
      console.log(`=== Attempt ${attempt}: Empty output ===`);
    }

    const review = extractReviewJson(text);
    if (review) {
      console.log(
        `Valid JSON with verdict='${review.verdict}' extracted on attempt ${attempt}`,
      );
      writeFileSync("/tmp/review.json", JSON.stringify(review));
      return;
    }

    if (attempt === MAX_ATTEMPTS) {
      console.error(
        `::error::Failed to extract valid review JSON after ${MAX_ATTEMPTS} attempts`,
      );
      process.exit(1);
    }

    let retryMsg: string;
    if (text.trim()) {
      retryMsg =
        "Your previous output could not be parsed as valid review JSON. " +
        "Please output ONLY a valid JSON object matching the required schema " +
        "(with verdict, optional summary, optional inline_comments). " +
        "No other text, no markdown fences.";
    } else {
      retryMsg =
        "You did not produce any visible text output. " +
        "Please output ONLY the review as a valid JSON object with " +
        "verdict (required), summary (optional), and inline_comments (optional). " +
        "No other text, no markdown fences.";
    }

    console.log(`::warning::Attempt ${attempt} failed, asking Claude to retry...`);
    text = runClaude({ prompt: retryMsg, continueSession: true });
  }
}

const isDirectRun =
  process.argv[1]?.endsWith("run-review.ts") ||
  process.argv[1]?.endsWith("run-review.js");
if (isDirectRun) {
  main();
}
