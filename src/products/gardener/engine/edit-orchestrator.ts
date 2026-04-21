/**
 * gardener respond — edit orchestrator primitive.
 *
 * The respond CLI reads reviewer feedback on a sync PR and (historically)
 * posted a placeholder acknowledgement reply. This primitive is the seam
 * where a real edit-plan → file edits → commit → push actually lands.
 *
 * v1 scope (per #160 / signoff on #219):
 *   - one deterministic heuristic: `parent_subdomain_missing`.
 *     Detected by matching reviewer body text for the "child not listed
 *     in parent NODE.md Sub-domains" pattern produced by gardener-sync.
 *     The fix appends a canonical `- \`<dir>/\` — <title>` line under
 *     the parent's `## Sub-domains` section.
 *   - an injected `planner` seam that can be swapped in later for an
 *     LLM-driven planner. When unset and the heuristic does not match,
 *     we return `deferred` so respond falls back to its placeholder
 *     reply path.
 *
 * Push semantics (per signoff):
 *   - `git push origin HEAD` only. No force-push, no `--force-with-lease`.
 *   - Non-fast-forwardable → `{ kind: "deferred", reason: "rebase_needed" }`.
 *
 * Attempts counter semantics (per signoff, owned by caller):
 *   - applied  → caller leaves the attempts counter unchanged
 *   - deferred → caller bumps the attempts counter (placeholder path)
 *   - failed   → caller leaves the attempts counter unchanged
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

import type { PrReview, PrIssueComment, PrView, ShellRun } from "./respond.js";

export interface EditFeedback {
  reviews: PrReview[];
  issueComments: PrIssueComment[];
  reviewerLogin?: string;
}

export interface EditPlan {
  pattern: string;
  summary: string;
  replyBody: string;
  files: Array<{ path: string; before: string; after: string }>;
}

export interface EditPlanner {
  (input: {
    feedback: EditFeedback;
    prView: PrView;
    treeRoot: string;
  }): Promise<EditPlan | null> | EditPlan | null;
}

export interface OrchestrateEditOptions {
  repo: string;
  pr: number;
  treeRoot: string;
  feedback: EditFeedback;
  prView: PrView;
  shell: ShellRun;
  dryRun: boolean;
  planner?: EditPlanner;
}

export type OrchestrateEditResult =
  | { kind: "applied"; sha: string; pattern: string; replyBody: string }
  | { kind: "deferred"; reason: string; replyBody?: string }
  | { kind: "failed"; reason: string };

/**
 * Resolve a reviewer-supplied relative path against the tree root and
 * require it to:
 *   - stay inside the tree checkout (no `..` traversal, no absolute paths)
 *   - target a file named `NODE.md`
 *
 * Returns null on any violation so callers can deferred-fall-back
 * without touching disk.
 */
function resolveInsideTree(treeRoot: string, input: string): string | null {
  const cleaned = input.replace(/^\.?\/+/, "").trim();
  if (!cleaned) return null;
  // Reject absolute paths outright — reviewer text must be tree-relative.
  if (cleaned.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(cleaned)) return null;
  const rootAbs = resolve(treeRoot);
  const target = resolve(rootAbs, cleaned);
  const rel = relative(rootAbs, target);
  if (rel.startsWith("..") || rel === "" || rel.split(sep).includes("..")) {
    return null;
  }
  if (basename(target) !== "NODE.md") return null;
  return target;
}

const PARENT_SUBDOMAIN_PATTERNS = [
  /not listed in (?:the )?parent\s+NODE\.md/i,
  /missing from (?:the )?(?:parent'?s? )?Sub-?domains/i,
  /add (?:this|the new) (?:child |sub-?domain )?(?:to|under) (?:the )?parent/i,
];

/**
 * Detect the `parent_subdomain_missing` pattern from reviewer text.
 *
 * Returns a plan only when we can identify both the parent NODE.md path
 * and a child dirName + title pair from the PR context. Anything fuzzier
 * than that is handed to the planner seam (or deferred).
 */
function detectParentSubdomainMissing(
  feedback: EditFeedback,
  prView: PrView,
  treeRoot: string,
): EditPlan | null {
  const reviewTexts = feedback.reviews
    .filter((r) => r.state === "CHANGES_REQUESTED")
    .map((r) => r.body ?? "");
  const commentTexts = feedback.issueComments.map((c) => c.body ?? "");
  const blob = [...reviewTexts, ...commentTexts].join("\n\n");
  if (!blob.trim()) return null;

  const matched = PARENT_SUBDOMAIN_PATTERNS.some((re) => re.test(blob));
  if (!matched) return null;

  // Extract parent path + child info from reviewer body.
  //
  // We accept either:
  //   - an explicit `parent: <path>` hint
  //   - a `<path>/<dir>/NODE.md` reference, from which we infer the
  //     parent as the NODE.md one level up. The full relative path is
  //     preserved so nested nodes (e.g. `engineering/mcp/NODE.md`) resolve
  //     to the right parent (`engineering/NODE.md`), not the tree root.
  const parentHint = blob.match(/parent(?:\s+NODE\.md)?\s*[:=]\s*([^\s`]+)/i);
  const childRef = blob.match(/([A-Za-z0-9._\-/]+?)\/NODE\.md/);
  const titleHint = blob.match(/title\s*[:=]\s*["']?([^"'\n]+)["']?/i);

  let parentPath: string | null = null;
  let childDir: string | null = null;
  let childRelative: string | null = null;

  if (childRef) {
    childRelative = childRef[1].replace(/^\.?\/+/, "");
    childDir = basename(childRelative);
  }

  if (parentHint) {
    const hinted = resolveInsideTree(treeRoot, parentHint[1]);
    if (!hinted) return null;
    parentPath = hinted;
  } else if (childRelative) {
    // Parent NODE.md is one level up from the child's NODE.md — preserve
    // the full relative path so nested children resolve correctly.
    const parentDir = dirname(childRelative);
    const parentRel = parentDir === "." || parentDir === ""
      ? "NODE.md"
      : `${parentDir}/NODE.md`;
    const resolved = resolveInsideTree(treeRoot, parentRel);
    if (!resolved) return null;
    parentPath = resolved;
  }

  if (!parentPath || !childDir) return null;

  let before: string;
  try {
    before = readFileSync(parentPath, "utf-8");
  } catch {
    return null;
  }

  // Idempotency: if the child is already listed under ## Sub-domains,
  // nothing to do. Match the actual entry token (`` `dir/` `` or
  // `[dir/](dir/NODE.md)`) rather than substring-with-word-boundary,
  // which false-positives on hyphenated siblings (#195 follow-up).
  const escaped = childDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const backtickRe = new RegExp(`\`${escaped}/\``);
  const linkRe = new RegExp(
    `\\[${escaped}/\\]\\(${escaped}/NODE\\.md\\)`,
  );
  const subDomainsMatch = before.match(
    /(##\s*Sub-?domains?[^\n]*\n)([\s\S]*?)(\n##|\n---|$)/i,
  );
  if (
    subDomainsMatch &&
    (backtickRe.test(subDomainsMatch[2]) || linkRe.test(subDomainsMatch[2]))
  ) {
    return null;
  }

  const title = (titleHint?.[1] ?? childDir).trim();
  const newLine = `- \`${childDir}/\` — ${title}\n`;

  let after: string;
  if (subDomainsMatch) {
    const [, header, block, trailer] = subDomainsMatch;
    const newBlock = block.endsWith("\n") ? `${block}${newLine}` : `${block}\n${newLine}`;
    after = before.replace(subDomainsMatch[0], `${header}${newBlock}${trailer}`);
  } else {
    // No Sub-domains section yet — append one at the end.
    const sep = before.endsWith("\n") ? "" : "\n";
    after = `${before}${sep}\n## Sub-domains\n\n${newLine}`;
  }

  if (after === before) return null;

  return {
    pattern: "parent_subdomain_missing",
    summary: `add ${childDir}/ to parent Sub-domains`,
    replyBody:
      `Added \`${childDir}/\` to the parent \`NODE.md\` Sub-domains section.`,
    files: [{ path: parentPath, before, after }],
  };
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Apply a plan to the working tree, commit, and push.
 *
 * Never force-pushes. If the branch can't fast-forward, returns
 * `{ kind: "deferred", reason: "rebase_needed" }` so the caller falls
 * back to the placeholder reply.
 */
export async function orchestrateEdit(
  opts: OrchestrateEditOptions,
): Promise<OrchestrateEditResult> {
  const { treeRoot, feedback, prView, shell, dryRun, planner } = opts;

  let plan: EditPlan | null =
    detectParentSubdomainMissing(feedback, prView, treeRoot);

  if (!plan && planner) {
    try {
      const result = await planner({ feedback, prView, treeRoot });
      plan = result ?? null;
    } catch (err) {
      return {
        kind: "failed",
        reason: `planner error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (!plan) {
    return { kind: "deferred", reason: "unsupported_pattern" };
  }

  if (plan.files.length === 0) {
    return { kind: "deferred", reason: "empty_plan" };
  }

  if (dryRun) {
    return {
      kind: "applied",
      sha: "dry-run",
      pattern: plan.pattern,
      replyBody: plan.replyBody,
    };
  }

  // Apply edits to disk.
  for (const file of plan.files) {
    try {
      const current = readFileSync(file.path, "utf-8");
      if (current !== file.before) {
        return {
          kind: "deferred",
          reason: "stale_base",
        };
      }
      writeFileSync(file.path, ensureTrailingNewline(file.after), "utf-8");
    } catch (err) {
      return {
        kind: "failed",
        reason: `write failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Stage, commit, push (origin HEAD, no force).
  const relativePaths = plan.files.map((f) => f.path);
  const addRes = await shell("git", ["add", "--", ...relativePaths], {
    cwd: treeRoot,
  });
  if (addRes.code !== 0) {
    return { kind: "failed", reason: `git add: ${addRes.stderr.trim()}` };
  }

  const commitMsg = `gardener: ${plan.summary}\n\nApplied by gardener-respond for PR #${prView.number}.`;
  const commitRes = await shell(
    "git",
    ["commit", "-m", commitMsg],
    { cwd: treeRoot },
  );
  if (commitRes.code !== 0) {
    const out = `${commitRes.stdout}\n${commitRes.stderr}`;
    if (/nothing to commit/i.test(out)) {
      return { kind: "deferred", reason: "nothing_to_commit" };
    }
    return { kind: "failed", reason: `git commit: ${commitRes.stderr.trim()}` };
  }

  const pushRes = await shell(
    "git",
    ["push", "origin", "HEAD"],
    { cwd: treeRoot },
  );
  if (pushRes.code !== 0) {
    const out = `${pushRes.stdout}\n${pushRes.stderr}`;
    if (/non-fast-forward|fetch first|rejected/i.test(out)) {
      return { kind: "deferred", reason: "rebase_needed" };
    }
    return { kind: "failed", reason: `git push: ${pushRes.stderr.trim()}` };
  }

  const shaRes = await shell("git", ["rev-parse", "HEAD"], { cwd: treeRoot });
  const sha = shaRes.code === 0 ? shaRes.stdout.trim() : "unknown";

  return {
    kind: "applied",
    sha,
    pattern: plan.pattern,
    replyBody: plan.replyBody,
  };
}
