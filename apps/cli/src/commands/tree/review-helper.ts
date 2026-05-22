import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type ReviewResult = {
  inline_comments?: Array<{ comment: string; file: string; line: number }>;
  summary?: string;
  verdict: string;
};

export type ReviewRunner = (prompt: string) => string;

const DEFAULT_OUTPUT_PATH = join(tmpdir(), "first-tree-review.json");

function resolveClaudeBin(): string {
  const localBin = join(homedir(), ".local", "bin", "claude");
  return existsSync(localBin) ? localBin : "claude";
}

export function buildReviewPrompt(diffPath: string, repoRoot = process.cwd()): string {
  const parts: string[] = [];
  const files = ["AGENTS.md", "NODE.md"];

  for (const file of files) {
    const fullPath = join(repoRoot, file);
    if (existsSync(fullPath)) {
      parts.push(`## ${file}\n\n${readFileSync(fullPath, "utf-8")}`);
    }
  }

  parts.push(
    [
      "## Review Instructions",
      "",
      "Review the provided tree PR diff and return only valid JSON with this schema:",
      '{ "verdict": "APPROVE|COMMENT|REQUEST_CHANGES", "summary": "...", "inline_comments": [{"file":"...","line":1,"comment":"..."}] }',
      "",
      "## Diff",
      "",
      readFileSync(diffPath, "utf-8"),
    ].join("\n"),
  );

  return parts.join("\n\n");
}

export function extractReviewJson(text: string): ReviewResult | null {
  if (!text.trim()) {
    return null;
  }

  const cleaned = text.replace(/```json\s*/gu, "").replace(/```\s*/gu, "");
  const match = cleaned.match(/\{[\s\S]*\}/u);
  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof parsed.verdict !== "string" || parsed.verdict.length === 0) {
      return null;
    }
    return parsed as ReviewResult;
  } catch {
    return null;
  }
}

export function defaultReviewRunner(prompt: string): string {
  return execFileSync(resolveClaudeBin(), ["-p", prompt], {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

export function runTreeReview(options: {
  diffPath: string;
  outputPath?: string;
  repoRoot?: string;
  runner?: ReviewRunner;
}): number {
  const prompt = buildReviewPrompt(options.diffPath, options.repoRoot);
  const text = (options.runner ?? defaultReviewRunner)(prompt);
  const review = extractReviewJson(text);

  if (review === null) {
    console.error("Failed to extract valid review JSON from the review runner output.");
    return 1;
  }

  const outputPath = options.outputPath ?? DEFAULT_OUTPUT_PATH;
  writeFileSync(outputPath, `${JSON.stringify(review, null, 2)}\n`);
  return 0;
}
