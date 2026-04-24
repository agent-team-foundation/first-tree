/**
 * Claude-CLI-backed Classifier.
 *
 * Spawns the locally installed `claude` binary as a subprocess and
 * feeds it the same prompt the Anthropic REST classifier uses, then
 * parses the JSON verdict with the shared `verdict-parse` helpers.
 *
 * Why shell out instead of hitting the REST API directly:
 *   - users on a dev box already have `claude` installed and
 *     authenticated (OAuth via their Claude subscription); requiring
 *     a separate `ANTHROPIC_API_KEY` on top of that is redundant UX
 *     friction (#269)
 *   - `claude` handles its own auth (OAuth, Bedrock, Vertex, API key)
 *     so we don't re-implement OAuth refresh or keychain access
 *   - mirrors what breeze-runner already does for Claude invocations,
 *     keeping our auth story unified across tools
 *
 * On any error (spawn failure, non-zero exit, unparseable output) we
 * throw a `ClaudeCliClassifierError` so the selector in cli.ts can
 * decide whether to transparently retry on the api-key path.
 */

import { spawn } from "node:child_process";
import type {
  Classifier,
  ClassifyInput,
  ClassifyOutput,
} from "../comment.js";
import { collectTreeDigest, formatDigest } from "./tree-digest.js";
import {
  parseVerdictJson,
  validateAndGroundNodes,
} from "./verdict-parse.js";

const DEFAULT_MODEL = "claude-haiku-4-5";
const DIFF_CAP = 20_000;
const SPAWN_TIMEOUT_MS = 90_000;

export type ClaudeCliFailureKind =
  | "binary_not_found"
  | "auth_failed"
  | "spawn_error"
  | "non_zero_exit"
  | "unparseable_output"
  | "timeout";

export class ClaudeCliClassifierError extends Error {
  readonly kind: ClaudeCliFailureKind;
  readonly stderr: string;
  constructor(kind: ClaudeCliFailureKind, message: string, stderr = "") {
    super(message);
    this.name = "ClaudeCliClassifierError";
    this.kind = kind;
    this.stderr = stderr;
  }
}

export interface ClaudeCliClassifierOptions {
  /** Override the binary name or path. Defaults to "claude". */
  binary?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected spawner for tests. */
  spawnImpl?: typeof spawn;
}

export function buildClaudeCliEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY: _anthropicApiKey, ...rest } = env;
  return rest;
}

export function createClaudeCliClassifier(
  opts: ClaudeCliClassifierOptions = {},
): Classifier {
  const binary = opts.binary ?? "claude";
  const model = opts.model?.trim() || DEFAULT_MODEL;
  const env = buildClaudeCliEnvironment(opts.env ?? process.env);
  const doSpawn = opts.spawnImpl ?? spawn;
  return async (input: ClassifyInput): Promise<ClassifyOutput> => {
    const digest = formatDigest(collectTreeDigest(input.treeRoot));
    const prompt = buildPrompt(input, digest);
    const { stdout, stderr, code, timedOut } = await runClaude(
      doSpawn,
      binary,
      model,
      prompt,
      env,
    );
    if (timedOut) {
      throw new ClaudeCliClassifierError(
        "timeout",
        `claude -p exceeded ${SPAWN_TIMEOUT_MS}ms`,
        stderr,
      );
    }
    if (code !== 0) {
      const kind = classifyFailure(code, stderr);
      throw new ClaudeCliClassifierError(
        kind,
        `claude -p exited ${code}`,
        stderr,
      );
    }
    const parsed = parseVerdictJson(stdout);
    if (!parsed) {
      throw new ClaudeCliClassifierError(
        "unparseable_output",
        `could not parse verdict JSON from claude output: ${stdout.slice(0, 200)}`,
        stderr,
      );
    }
    return validateAndGroundNodes(parsed, input.treeRoot);
  };
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

function runClaude(
  spawner: typeof spawn,
  binary: string,
  model: string,
  prompt: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolveRun) => {
    let child;
    try {
      // `env` is pre-scrubbed by buildClaudeCliEnvironment so claude-cli
      // uses the local session path instead of inheriting
      // ANTHROPIC_API_KEY from the parent process.
      child = spawner(binary, [
        "-p",
        "--output-format",
        "text",
        "--model",
        model,
        "--disable-slash-commands",
        "--setting-sources",
        "user",
        "--tools",
        "",
      ], {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ClaudeCliClassifierError(
        msg.includes("ENOENT") ? "binary_not_found" : "spawn_error",
        `failed to spawn ${binary}: ${msg}`,
      );
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, SPAWN_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      const kind = (err as NodeJS.ErrnoException).code === "ENOENT"
        ? "binary_not_found"
        : "spawn_error";
      // Resolve with a synthetic non-zero exit so the caller can classify.
      resolveRun({
        stdout,
        stderr: stderr + `\n[spawn error: ${err.message}]`,
        code: kind === "binary_not_found" ? 127 : 1,
        timedOut: false,
      });
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr, code, timedOut });
    });
    // Feed prompt on stdin and close to let claude process.
    child.stdin?.end(prompt, "utf-8");
  });
}

function classifyFailure(
  code: number | null,
  stderr: string,
): ClaudeCliFailureKind {
  if (code === 127) return "binary_not_found";
  const lower = stderr.toLowerCase();
  // Claude Code surfaces a few shapes when the user isn't logged in
  // (expired token, never ran `claude login`, revoked). We conflate
  // them into one "auth_failed" kind so the selector can retry.
  const authSignals = [
    "not logged in",
    "please log in",
    "not authenticated",
    "authentication",
    "unauthorized",
    "401",
    "invalid api key",
    "invalid token",
    "invalid api key",
    "invalid_api_key",
    "fix external api key",
    "expired",
    "fix external api key",
  ];
  if (authSignals.some((s) => lower.includes(s))) return "auth_failed";
  return "non_zero_exit";
}

export function isAuthFailure(err: unknown): boolean {
  return err instanceof ClaudeCliClassifierError && err.kind === "auth_failed";
}

export function isBinaryMissing(err: unknown): boolean {
  return err instanceof ClaudeCliClassifierError
    && err.kind === "binary_not_found";
}

const SYSTEM_PROMPT = `You are the gardener: you review pull requests and issues on a source
code repo against a Context Tree (the tree captures cross-domain
decisions, constraints, and the "why" behind architectural choices).

Your job is to decide how this PR/issue relates to the decisions
recorded in the tree. You will be given a digest of every NODE.md in
the tree and the PR/issue content.

Respond with a single JSON object and nothing else:

{
  "verdict": "ALIGNED" | "NEW_TERRITORY" | "NEEDS_REVIEW" | "CONFLICT" | "INSUFFICIENT_CONTEXT",
  "severity": "low" | "medium" | "high" | "critical",
  "summary": "<one sentence, <= 200 chars, plain prose>",
  "treeNodes": [
    { "path": "<tree-root-relative path to NODE.md or leaf>", "summary": "<one line>" }
  ]
}

Verdict guidance:
- ALIGNED: the change clearly matches an existing tree decision. Cite the node.
- NEW_TERRITORY: the change is in an area the tree doesn't cover yet. treeNodes may be empty.
- NEEDS_REVIEW: touches tree-recorded decisions and deserves a human look, but isn't a direct conflict.
- CONFLICT: contradicts an existing tree decision. Cite the node that conflicts.
- INSUFFICIENT_CONTEXT: you cannot tell from the inputs. Use sparingly.

Severity guidance: match the blast radius. CONFLICT + critical for
decisions that would require a tree PR; ALIGNED is almost always low.

Only cite tree nodes whose paths appear in the digest. Do not invent
paths. Keep summaries terse — this comment is posted to a PR.`;

function buildPrompt(input: ClassifyInput, digest: string): string {
  const parts: string[] = [];
  parts.push(SYSTEM_PROMPT);
  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push("## Tree digest");
  parts.push(digest);
  parts.push("");
  if (input.type === "pr" && input.prView) {
    parts.push(`## PR #${input.prView.number ?? "?"}: ${input.prView.title ?? ""}`);
    if (input.prView.body) {
      parts.push("");
      parts.push(input.prView.body);
    }
    if (input.diff) {
      parts.push("");
      parts.push("## Diff");
      parts.push("```diff");
      parts.push(input.diff.slice(0, DIFF_CAP));
      if (input.diff.length > DIFF_CAP) {
        parts.push(`... (truncated, ${input.diff.length - DIFF_CAP} bytes omitted)`);
      }
      parts.push("```");
    }
  } else if (input.type === "issue" && input.issueView) {
    parts.push(`## Issue #${input.issueView.number ?? "?"}: ${input.issueView.title ?? ""}`);
    if (input.issueView.body) {
      parts.push("");
      parts.push(input.issueView.body);
    }
  } else {
    parts.push("(no PR or issue view supplied)");
  }
  return parts.join("\n");
}
