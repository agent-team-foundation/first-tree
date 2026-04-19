/**
 * LLM-as-judge helper for agent-e2e tests.
 *
 * The judge runs through the Claude Code CLI subprocess (shared with
 * the rest of the agent-e2e tier), not the raw Anthropic SDK. Two
 * practical benefits:
 *   - local maintainers with a Claude Code subscription pay nothing
 *     per test run (no separate API key needed)
 *   - CI still works unchanged: the `claude` CLI honours
 *     `ANTHROPIC_API_KEY` when present, so the same code path covers
 *     subscription and API-key auth
 *
 * The judge is constrained to a single turn (`maxTurns: 1`) so the
 * model cannot call tools, cannot read files, and cannot wander; it
 * returns a single assistant text block that we parse as strict JSON.
 *
 * Shape adapted from gstack's test/helpers/llm-judge.ts.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSession } from "#evals/helpers/session-runner.js";
import type { AgentConfig } from "#evals/helpers/types.js";

const JUDGE_AGENT: AgentConfig = {
  cli: "claude-code",
  model: "claude-sonnet-4-5",
};
const MAX_RETRIES = 3;
const JUDGE_TIMEOUT_MS = 120_000;

export interface JudgeScore {
  clarity: number;
  completeness: number;
  actionability: number;
  reasoning: string;
}

export interface JudgeAxis<Key extends string> {
  key: Key;
  description: string;
}

export interface JudgeVerdict<Axes extends string> {
  scores: Record<Axes, number>;
  reasoning: string;
  raw: string;
}

function extractJson(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return null;
  return text.slice(first, last + 1);
}

/**
 * Pull the last assistant text block out of a stream-json transcript.
 *
 * runSession returns `output = resultLine.result || ''`, which covers
 * the clean `subtype: success` path. When the session ends abnormally
 * (outer Stop hooks in nested Claude Code sessions, max-turns with a
 * populated final turn, etc.) the text still lives in the transcript,
 * and the judge only cares about it — not about why the process exited.
 */
function lastAssistantText(transcript: unknown[]): string | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const event = transcript[i] as
      | {
          type?: string;
          message?: { content?: Array<{ type?: string; text?: string }> };
        }
      | undefined;
    if (!event || event.type !== "assistant") continue;
    const items = event.message?.content ?? [];
    for (let j = items.length - 1; j >= 0; j--) {
      const item = items[j];
      if (item && item.type === "text" && typeof item.text === "string") {
        return item.text;
      }
    }
  }
  return null;
}

/**
 * Single-turn Claude subprocess call.
 *
 * `maxTurns: 1` forbids tool use — the model emits one assistant
 * message and exits. We prefer the clean `result.output` path and
 * fall back to scraping the transcript's last assistant text.
 */
async function callClaude(prompt: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const workDir = mkdtempSync(join(tmpdir(), "first-tree-judge-"));
    try {
      const result = await runSession({
        prompt,
        workingDirectory: workDir,
        agent: JUDGE_AGENT,
        maxTurns: 1,
        timeout: JUDGE_TIMEOUT_MS,
        testName: "agent-e2e-judge",
      });
      if (result.output && result.output.trim().length > 0) {
        return result.output;
      }
      const fallback = lastAssistantText(result.transcript as unknown[]);
      if (fallback && fallback.trim().length > 0) return fallback;
      lastError = new Error(
        `judge returned no text (exit_reason=${result.exitReason}, turns=${result.toolCalls.length})`,
      );
    } catch (err) {
      lastError = err;
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
    const delay = 500 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw lastError;
}

/**
 * Score an arbitrary string against a set of named axes.
 *
 * The judge is instructed to return strict JSON with integer scores
 * and a single reasoning field. Missing or non-numeric scores raise.
 */
export async function judgeAgainstAxes<Axes extends string>(args: {
  subject: string;
  content: string;
  axes: Array<JudgeAxis<Axes>>;
}): Promise<JudgeVerdict<Axes>> {
  const axesDoc = args.axes
    .map((a, i) => `  ${i + 1}. ${a.key} (1–5): ${a.description}`)
    .join("\n");

  const prompt = `You are an impartial judge evaluating the quality of ${args.subject}.

Score the content below on each axis from 1 (bad) to 5 (excellent).
Axes:
${axesDoc}

Respond with STRICT JSON only, matching this schema:
{
${args.axes.map((a) => `  "${a.key}": <integer 1-5>,`).join("\n")}
  "reasoning": "<one short paragraph explaining the scores>"
}

No prose outside the JSON. No markdown fences. No tool calls. No commentary.

--- BEGIN CONTENT ---
${args.content}
--- END CONTENT ---`;

  const raw = await callClaude(prompt);
  const json = extractJson(raw);
  if (!json) {
    throw new Error(`judge returned non-JSON output:\n${raw.slice(0, 400)}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `judge JSON parse failed: ${(err as Error).message}\n--- raw ---\n${raw.slice(0, 400)}`,
    );
  }

  const scores = {} as Record<Axes, number>;
  for (const axis of args.axes) {
    const value = parsed[axis.key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `judge did not return numeric score for "${axis.key}": ${JSON.stringify(value)}`,
      );
    }
    const clamped = Math.max(1, Math.min(5, Math.round(value)));
    scores[axis.key] = clamped;
  }
  const reasoning =
    typeof parsed.reasoning === "string" ? parsed.reasoning : "";
  return { scores, reasoning, raw };
}

/**
 * Convenience wrapper for the three canonical SKILL.md quality axes.
 */
export async function judgeSkillQuality(args: {
  skillName: string;
  content: string;
}): Promise<JudgeScore> {
  const verdict = await judgeAgainstAxes({
    subject: `the SKILL.md file for "${args.skillName}"`,
    content: args.content,
    axes: [
      {
        key: "clarity" as const,
        description:
          "Can a coding agent unambiguously understand what each step does without guessing?",
      },
      {
        key: "completeness" as const,
        description:
          "Are all inputs, outputs, commands, arguments, valid values, and edge cases covered?",
      },
      {
        key: "actionability" as const,
        description:
          "Can the agent take concrete action (construct correct CLI invocations, pick the right flow) using only this file?",
      },
    ],
  });
  return {
    clarity: verdict.scores.clarity,
    completeness: verdict.scores.completeness,
    actionability: verdict.scores.actionability,
    reasoning: verdict.reasoning,
  };
}

/**
 * The judge is available iff
 *   - FIRST_TREE_AGENT_TESTS=1 is set, AND
 *   - the `claude` CLI is on PATH (it will authenticate via the
 *     user's subscription OR via ANTHROPIC_API_KEY — whichever is
 *     present at invocation time).
 */
export function judgeAvailable(): boolean {
  if (process.env.FIRST_TREE_AGENT_TESTS !== "1") return false;
  try {
    const result = spawnSync("claude", ["--version"], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}
