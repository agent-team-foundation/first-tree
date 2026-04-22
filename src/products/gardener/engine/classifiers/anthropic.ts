/**
 * Anthropic-backed Classifier for the gardener comment pipeline.
 *
 * Gated on `ANTHROPIC_API_KEY`. When the key is present, the CLI wires
 * this into `runComment`; when absent, runComment refuses to post (see
 * #253). The default model is `claude-haiku-4-5` — cheap and fast
 * enough for per-PR review cadence. Override with
 * `GARDENER_CLASSIFIER_MODEL` if you need better judgment at more cost.
 *
 * The model receives:
 *   - a role prompt explaining the verdict schema
 *   - the NODE.md digest for this tree (see tree-digest.ts)
 *   - the PR title/body/diff (or issue title/body)
 * and must respond with a single JSON object matching ClassifyOutput.
 *
 * On any error (network, non-JSON response, bad schema) we return the
 * INSUFFICIENT_CONTEXT sentinel with a diagnostic summary so the
 * downstream pipeline can still skip cleanly instead of posting garbage.
 */

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

// Re-export so existing importers (tests, other classifiers) keep
// working without depending on the new file path directly.
export { parseVerdictJson, validateAndGroundNodes } from "./verdict-parse.js";

const DEFAULT_MODEL = "claude-haiku-4-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 1024;
const DIFF_CAP = 20_000;
const FETCH_TIMEOUT_MS = 60_000;

export interface AnthropicClassifierOptions {
  apiKey: string;
  model?: string;
  /** Injected fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function createAnthropicClassifier(
  opts: AnthropicClassifierOptions,
): Classifier {
  const model = opts.model?.trim() || DEFAULT_MODEL;
  const doFetch = opts.fetchImpl ?? fetch;
  return async (input: ClassifyInput): Promise<ClassifyOutput> => {
    const digest = formatDigest(collectTreeDigest(input.treeRoot));
    const userPrompt = buildUserPrompt(input, digest);
    try {
      const res = await doFetch(ANTHROPIC_URL, {
        method: "POST",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return fallback(
          `anthropic API ${res.status}: ${text.slice(0, 200)}`,
        );
      }
      const body = (await res.json()) as AnthropicMessagesResponse;
      const text = extractText(body);
      if (!text) return fallback("anthropic response had no text content");
      const parsed = parseVerdictJson(text);
      if (!parsed) {
        return fallback(
          `could not parse verdict JSON from model output: ${text.slice(0, 200)}`,
        );
      }
      return validateAndGroundNodes(parsed, input.treeRoot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fallback(`anthropic classifier error: ${msg}`);
    }
  };
}

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

function extractText(body: AnthropicMessagesResponse): string | null {
  if (!body.content) return null;
  const joined = body.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  return joined.length > 0 ? joined : null;
}

function fallback(reason: string): ClassifyOutput {
  return {
    verdict: "INSUFFICIENT_CONTEXT",
    severity: "low",
    summary: reason,
    treeNodes: [],
  };
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

function buildUserPrompt(input: ClassifyInput, digest: string): string {
  const parts: string[] = [];
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

export { SYSTEM_PROMPT, buildUserPrompt };
