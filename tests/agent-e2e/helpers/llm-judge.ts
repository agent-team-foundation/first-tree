/**
 * LLM-as-judge helper for agent-e2e tests.
 *
 * Pattern adapted from gstack's test/helpers/llm-judge.ts: a strict-JSON
 * judge that scores an input against named axes (1–5), with automatic
 * retry on malformed output and on rate limits.
 *
 * Only runs when `FIRST_TREE_AGENT_TESTS=1` and `ANTHROPIC_API_KEY` are
 * both set. The judge model is fixed (sonnet); bumping it is a
 * decision-grade change because baselines are pinned against it.
 */

import Anthropic from "@anthropic-ai/sdk";

const JUDGE_MODEL = "claude-sonnet-4-5";
const MAX_RETRIES = 3;

export interface JudgeScore {
  clarity: number;
  completeness: number;
  actionability: number;
  reasoning: string;
}

export interface JudgeAxis {
  name: string;
  description: string;
  /** Inclusive, 1–5. */
  min: number;
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

async function callAnthropic(prompt: string): Promise<string> {
  const client = new Anthropic();
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model: JUDGE_MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });
      const block = response.content.find((b) => b.type === "text");
      if (block && block.type === "text") return block.text;
      throw new Error("judge response had no text block");
    } catch (err) {
      lastError = err;
      const delay = 500 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/**
 * Score an arbitrary string against a set of named axes.
 *
 * The judge is instructed to return strict JSON with integer scores and
 * a single reasoning field. Missing or non-numeric scores raise.
 */
export async function judgeAgainstAxes<Axes extends string>(args: {
  subject: string;
  content: string;
  axes: Array<{ key: Axes; description: string }>;
}): Promise<JudgeVerdict<Axes>> {
  const axesDoc = args.axes
    .map(
      (a, i) =>
        `  ${i + 1}. ${a.key} (1–5): ${a.description}`,
    )
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

No prose outside the JSON. No markdown fences. No commentary.

--- BEGIN CONTENT ---
${args.content}
--- END CONTENT ---`;

  const raw = await callAnthropic(prompt);
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
 * The axes mirror gstack/test/helpers/llm-judge.ts::judge().
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

export function judgeAvailable(): boolean {
  if (process.env.FIRST_TREE_AGENT_TESTS !== "1") return false;
  if (!process.env.ANTHROPIC_API_KEY) return false;
  return true;
}
