#!/usr/bin/env node
/**
 * Run Claude Code review and extract structured JSON output.
 *
 * Builds the review prompt, invokes Claude Code with stream-json output,
 * extracts text from the stream, parses the review JSON, and retries up
 * to 3 times on failure. Writes the validated review JSON to /tmp/review.json.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const CLAUDE_BIN = join(homedir(), ".local", "bin", "claude");
const MAX_ATTEMPTS = 3;
// Per-invocation budget cap. Worst case is $1.50 total (3 × $0.50),
// though retries are cheap in practice due to cached context via --continue.
const MAX_BUDGET_USD = 0.5;
const AGENT_INSTRUCTIONS_PATHS = ["AGENTS.md", "AGENT.md"] as const;
const DEFAULT_PR_METADATA_PATH = "/tmp/pr-metadata.json";

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

export function buildPrompt(
  diffPath: string,
  reviewPromptPath: string,
  options: PrepareReviewWorkspaceOptions = {},
): string {
  const reviewWorkspace = prepareReviewWorkspace(diffPath, {
    prMetadataPath: options.prMetadataPath ?? DEFAULT_PR_METADATA_PATH,
    prMetadata: options.prMetadata,
    workspaceRoot: options.workspaceRoot,
  });
  const parts: string[] = [];
  const agentInstructionsPath = resolveAgentInstructionsPath();
  const files: [string, string][] = [
    [agentInstructionsPath, agentInstructionsPath],
    ["Root NODE.md", "NODE.md"],
    ["Review Instructions", reviewPromptPath],
  ];
  for (const [heading, path] of files) {
    const content = readFileSync(path, "utf-8");
    parts.push(`## ${heading}\n\n${content}`);
  }
  parts.push(
    [
      "## PR Review Context",
      "",
      "You are running inside a checked-out Context Tree repo with local file and shell access.",
      "Do not load the entire raw diff unless it is absolutely necessary.",
      "Start from the PR overview and changed-file manifest below, then inspect only the",
      "per-file patches and tree files needed to reach your review.",
      "",
      renderPrOverview(reviewWorkspace.metadata),
      "",
      "## Changed Files Manifest",
      "",
      reviewWorkspace.manifestMarkdown,
      "",
      "## On-Demand Evidence",
      "",
      `- Structured manifest JSON: \`${reviewWorkspace.manifestPath}\``,
      `- Per-file patch directory: \`${reviewWorkspace.patchesDir}\``,
      `- Full raw diff (use only if required): \`${reviewWorkspace.fullDiffPath}\``,
    ].join("\n"),
  );
  return parts.join("\n\n");
}

export interface PrMetadataFile {
  path: string;
  additions?: number;
  deletions?: number;
}

export interface PrMetadata {
  url?: string;
  title?: string;
  body?: string;
  files?: PrMetadataFile[];
}

export interface DiffSection {
  oldPath: string;
  newPath: string;
  path: string;
  patch: string;
}

export interface ReviewWorkspaceFile extends PrMetadataFile {
  oldPath?: string;
  newPath?: string;
  patchPath?: string;
}

interface ReviewWorkspaceManifest {
  pr: {
    url?: string;
    title?: string;
    body?: string;
    metadataPath?: string;
  };
  files: ReviewWorkspaceFile[];
  fullDiffPath: string;
}

export interface ReviewWorkspace {
  rootDir: string;
  patchesDir: string;
  manifestPath: string;
  manifestMarkdown: string;
  fullDiffPath: string;
  metadata: PrMetadata | null;
  files: ReviewWorkspaceFile[];
}

interface PrepareReviewWorkspaceOptions {
  prMetadataPath?: string;
  prMetadata?: PrMetadata | null;
  workspaceRoot?: string;
}

function readPrMetadata(path: string): PrMetadata | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as PrMetadata;
  } catch {
    return null;
  }
}

function parseDiffHeader(line: string): { oldPath: string; newPath: string } | null {
  const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!match) {
    return null;
  }
  return {
    oldPath: match[1],
    newPath: match[2],
  };
}

export function splitDiffByFile(diffText: string): DiffSection[] {
  const sections: DiffSection[] = [];
  const lines = diffText.split("\n");
  let currentHeader: { oldPath: string; newPath: string } | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentHeader || currentLines.length === 0) {
      currentHeader = null;
      currentLines = [];
      return;
    }

    sections.push({
      oldPath: currentHeader.oldPath,
      newPath: currentHeader.newPath,
      path: currentHeader.newPath === "/dev/null" ? currentHeader.oldPath : currentHeader.newPath,
      patch: currentLines.join("\n"),
    });
    currentHeader = null;
    currentLines = [];
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      currentHeader = parseDiffHeader(line);
      currentLines = [line];
      continue;
    }

    if (currentHeader) {
      currentLines.push(line);
    }
  }

  flush();
  return sections;
}

function sanitizePatchFilename(path: string, index: number): string {
  const cleaned = path.replace(/[^A-Za-z0-9._-]+/g, "__").replace(/^_+|_+$/g, "");
  return `${String(index).padStart(4, "0")}-${cleaned || "file"}.diff`;
}

function renderPrOverview(metadata: PrMetadata | null): string {
  if (!metadata) {
    return "## PR Overview\n\n- PR metadata file was not available. Use the changed-file manifest below.";
  }

  const lines = ["## PR Overview", ""];
  if (metadata.url) {
    lines.push(`- URL: ${metadata.url}`);
  }
  if (metadata.title) {
    lines.push(`- Title: ${metadata.title}`);
  }
  if (metadata.body) {
    lines.push(`- Body: ${metadata.body}`);
  }
  if (metadata.files?.length) {
    lines.push(`- Changed files: ${metadata.files.length}`);
  }

  return lines.join("\n");
}

function renderManifestMarkdown(files: ReviewWorkspaceFile[]): string {
  if (files.length === 0) {
    return "- No changed files were reported.";
  }

  return files
    .map((file) => {
      const counts =
        typeof file.additions === "number" || typeof file.deletions === "number"
          ? ` (+${file.additions ?? 0} / -${file.deletions ?? 0})`
          : "";
      const patchRef = file.patchPath ? ` -> \`${file.patchPath}\`` : "";
      return `- \`${file.path}\`${counts}${patchRef}`;
    })
    .join("\n");
}

export function prepareReviewWorkspace(
  diffPath: string,
  options: PrepareReviewWorkspaceOptions = {},
): ReviewWorkspace {
  const prMetadata =
    options.prMetadata ??
    (options.prMetadataPath ? readPrMetadata(options.prMetadataPath) : null) ??
    readPrMetadata(DEFAULT_PR_METADATA_PATH);
  const diffText = readFileSync(diffPath, "utf-8");
  const sections = splitDiffByFile(diffText);
  const rootDir =
    options.workspaceRoot ?? mkdtempSync(join(tmpdir(), "first-tree-review-"));
  const patchesDir = join(rootDir, "patches");
  mkdirSync(patchesDir, { recursive: true });

  const patchPathByKey = new Map<string, string>();
  for (const [index, section] of sections.entries()) {
    const patchPath = join(patchesDir, sanitizePatchFilename(section.path, index));
    writeFileSync(patchPath, section.patch);
    patchPathByKey.set(section.path, patchPath);
    patchPathByKey.set(section.oldPath, patchPath);
    patchPathByKey.set(section.newPath, patchPath);
  }

  const files: ReviewWorkspaceFile[] =
    prMetadata?.files && prMetadata.files.length > 0
      ? prMetadata.files.map((file) => ({
          ...file,
          patchPath: patchPathByKey.get(file.path),
        }))
      : sections.map((section) => ({
          path: section.path,
          oldPath: section.oldPath,
          newPath: section.newPath,
          patchPath: patchPathByKey.get(section.path),
        }));

  const manifestPath = join(rootDir, "manifest.json");
  const manifest: ReviewWorkspaceManifest = {
    pr: {
      url: prMetadata?.url,
      title: prMetadata?.title,
      body: prMetadata?.body,
      metadataPath: options.prMetadataPath ?? (prMetadata ? DEFAULT_PR_METADATA_PATH : undefined),
    },
    files,
    fullDiffPath: diffPath,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    rootDir,
    patchesDir,
    manifestPath,
    manifestMarkdown: renderManifestMarkdown(files),
    fullDiffPath: diffPath,
    metadata: prMetadata,
    files,
  };
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

export interface RunReviewOptions {
  diffPath?: string;
  reviewPromptPath: string;
  outputPath?: string;
}

export function runReview(options: RunReviewOptions): number {
  const diffPath = options.diffPath ?? "/tmp/pr-diff.txt";
  const outputPath = options.outputPath ?? "/tmp/review.json";
  const prompt = buildPrompt(diffPath, options.reviewPromptPath);
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
      writeFileSync(outputPath, JSON.stringify(review));
      return 0;
    }

    if (attempt === MAX_ATTEMPTS) {
      console.error(
        `::error::Failed to extract valid review JSON after ${MAX_ATTEMPTS} attempts`,
      );
      return 1;
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

  return 1;
}
