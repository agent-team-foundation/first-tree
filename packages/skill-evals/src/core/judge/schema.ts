import { isRecord } from "../events.js";
import type { JudgeEvaluation, JudgeRubricDimension, ParsedJudgeOutput } from "./types.js";

function scoreFailurePrefix(dimensions: readonly JudgeRubricDimension[]): string {
  return `Expected JSON object with scores for: ${dimensions.map((dimension) => dimension.key).join(", ")}`;
}

export function parseJudgeJson(rawOutput: string, dimensions: readonly JudgeRubricDimension[]): ParsedJudgeOutput {
  const trimmed = rawOutput.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Judge output is not strict JSON: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error("Judge output must be a JSON object.");
  }

  const scores = parsed.scores;
  if (!isRecord(scores)) {
    throw new Error(`${scoreFailurePrefix(dimensions)} under a scores object.`);
  }

  const judgeScores: Record<string, number> = {};
  for (const dimension of dimensions) {
    const score = scores[dimension.key];
    if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 5) {
      throw new Error(`${dimension.key} score must be an integer from 1 to 5.`);
    }
    judgeScores[dimension.key] = score;
  }

  const reasoning = parsed.reasoning;
  if (typeof reasoning !== "string" || reasoning.trim() === "") {
    throw new Error("Judge output must include non-empty reasoning.");
  }

  return {
    judge_reasoning: reasoning,
    judge_scores: judgeScores,
  };
}

export function evaluateJudgeOutput(
  output: ParsedJudgeOutput,
  dimensions: readonly JudgeRubricDimension[],
): JudgeEvaluation {
  const failures: string[] = [];
  const thresholds: Record<string, number> = {};

  for (const dimension of dimensions) {
    thresholds[dimension.key] = dimension.threshold;
    const score = output.judge_scores[dimension.key];
    if (score === undefined || score < dimension.threshold) {
      failures.push(`${dimension.key}: ${score ?? "missing"} < ${dimension.threshold}`);
    }
  }

  return {
    ...output,
    failures,
    passed: failures.length === 0,
    thresholds,
  };
}
