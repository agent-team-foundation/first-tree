/**
 * gardener-draft-node — Phase 3 of the #277 onboarding pipeline.
 *
 * Consumes a tree-repo issue filed by `gardener sync --open-issues`
 * (or by the merged-PR branch of `gardener comment` — both paths emit
 * the same `<!-- gardener:sync-proposal · proposal_id=… · source_sha=…
 * · node=<path> -->` dispatch marker), writes the proposed NODE.md
 * body to disk, commits on a per-proposal branch, and opens a tree
 * PR. Called by breeze when the user is assigned on such an issue.
 *
 * BREEZE_RESULT trailer: the last line of stdout is always
 *   `BREEZE_RESULT: status=<handled|skipped|failed> summary=<...>`
 * so breeze-runner can parse the outcome from a captured stdout
 * buffer. Matches the shape of `comment` and `respond`.
 *
 * Non-goals for this module:
 *   - Classifier involvement: the "proposed node content" is already
 *     in the issue body. `draft-node` copies it through verbatim. If
 *     the owner wants edits, that's a human touch on the resulting
 *     PR, not this command's job.
 *   - Merged-PR path routing differences: the `source=merged-pr`
 *     marker field is not acted on here. Both paths produce a tree
 *     PR from the same body shape.
 */

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { ShellRun } from "#products/tree/engine/runtime/shell.js";
import { openTreePr } from "#products/tree/engine/open-tree-pr.js";

const execFileAsync = promisify(execFile);

export const DRAFT_NODE_USAGE = `usage: first-tree gardener draft-node --issue <n> --tree-repo <owner/name> [--tree-path PATH]

Draft a tree-node update from a gardener-filed proposal issue and open
a tree PR. Reads the \`<!-- gardener:sync-proposal · proposal_id=… ·
source_sha=… · node=<path> -->\` marker on the issue to locate the
target NODE.md, extracts the proposed content from the issue body, and
commits it on a per-proposal branch.

Triggered by breeze when the logged-in user is assigned on a tree-repo
issue labeled \`first-tree:sync-proposal\`. Idempotent: re-runs on the
same issue reuse the same branch + skip the commit if the content is
already applied.

Options:
  --issue <n>           Tree-repo issue number (required)
  --tree-repo <slug>    Tree repo (owner/name). Default: resolved from
                        \`gh repo view\` inside --tree-path.
  --tree-path PATH      Tree repo directory (default: cwd)
  --dry-run             Print planned actions; do not write, commit, or push
  --help, -h            Show this help message

Environment:
  TREE_REPO_TOKEN       PAT with repo scope on the tree repo. Required
                        for the \`gh issue view\` call and for
                        \`gh pr create\`. No fallback to ambient \`gh\`
                        auth — unset → skipped.
  DRAFT_NODE_LOG        Optional JSONL event log path (default
                        $HOME/.gardener/draft-node-runs.jsonl).

Exit codes:
  0 handled/skipped
  1 unrecoverable error
`;

export interface DraftNodeDeps {
  write?: (line: string) => void;
  shell?: ShellRun;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export type DraftNodeStatus = "handled" | "skipped" | "failed";

export interface ParsedFlags {
  help: boolean;
  issue: number | null;
  treeRepo: string | null;
  treePath: string | null;
  dryRun: boolean;
  unknown: string | null;
}

export function parseFlags(args: string[]): ParsedFlags {
  const out: ParsedFlags = {
    help: false,
    issue: null,
    treeRepo: null,
    treePath: null,
    dryRun: false,
    unknown: null,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (arg === "--issue") {
      const next = args[i + 1];
      const parsed = Number(next);
      if (Number.isFinite(parsed) && parsed > 0) {
        out.issue = parsed;
        i += 1;
        continue;
      }
      out.unknown = `--issue requires a positive integer, got: ${next ?? "(missing)"}`;
      return out;
    }
    if (arg === "--tree-repo") {
      const next = args[i + 1];
      if (next && /^[^/\s]+\/[^/\s]+$/.test(next)) {
        out.treeRepo = next;
        i += 1;
        continue;
      }
      out.unknown = `--tree-repo requires owner/name, got: ${next ?? "(missing)"}`;
      return out;
    }
    if (arg === "--tree-path") {
      const next = args[i + 1];
      if (next) {
        out.treePath = next;
        i += 1;
        continue;
      }
      out.unknown = `--tree-path requires a path`;
      return out;
    }
    out.unknown = arg;
    return out;
  }
  return out;
}

export interface ProposalMarker {
  proposalId: string;
  sourceSha: string;
  node: string;
  source: string | null;
  sourcePr: string | null;
}

const MARKER_RE =
  /<!--\s*gardener:sync-proposal\s+([^>]+?)\s*-->/;

/**
 * Normalize the `node=<path>` field from a sync-proposal marker.
 *
 * Earlier gardener versions wrote the marker's `node=` as the tree
 * directory path (`product/task-system/stale-execution-lock-recovery`),
 * but a later change started emitting the trailing `/NODE.md`
 * (`…/stale-execution-lock-recovery/NODE.md`). draft-node always appends
 * `NODE.md` before writing, which silently produced the doubled
 * `…/NODE.md/NODE.md` path seen on paperclip-tree#336.
 *
 * Treat both forms as equivalent: the marker names a node directory,
 * and draft-node is the single authority on where `NODE.md` lives
 * inside it. Strips optional trailing `/NODE.md` (case-insensitive on
 * the filename). Also trims trailing slashes so `join()` behaves.
 *
 * Fixes #306.
 */
export function normalizeMarkerNode(raw: string | undefined): string {
  if (!raw) return "";
  let out = raw.trim();
  // Strip a trailing `/NODE.md` (case-insensitive on the basename).
  const withoutNodeMd = out.replace(/\/NODE\.md\/*$/iu, "");
  if (withoutNodeMd !== out) {
    out = withoutNodeMd;
  }
  // Trim any remaining trailing slashes.
  out = out.replace(/\/+$/u, "");
  return out;
}

/**
 * Parse the `<!-- gardener:sync-proposal · k=v · k=v … -->` marker.
 * Returns null when no marker is present or required fields are
 * missing. Field order-insensitive; accepts the middle-dot separator
 * emitted by both sync and comment paths.
 */
export function parseProposalMarker(body: string): ProposalMarker | null {
  const match = body.match(MARKER_RE);
  if (!match) return null;
  const fields: Record<string, string> = {};
  const raw = match[1];
  for (const part of raw.split(/\s*[·•]\s*|\s{2,}/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key) fields[key] = val;
  }
  const proposalId = fields.proposal_id;
  const sourceSha = fields.source_sha;
  const node = normalizeMarkerNode(fields.node);
  if (!proposalId || !node) return null;
  return {
    proposalId,
    sourceSha: sourceSha ?? "unknown",
    node,
    source: fields.source ?? null,
    sourcePr: fields.source_pr ?? null,
  };
}

/**
 * Extract the proposed NODE.md body from a sync-proposal issue. The
 * convention (sync.ts:1389) is a `### Proposed node content\n` header
 * followed by the markdown and a trailing `\n---\n` separator.
 *
 * For the merged-PR path the body shape is different: no "Proposed
 * node content" section exists (the body describes the change, not a
 * ready-to-apply NODE update). In that case this function returns
 * null and callers defer — a human or a later classifier pass has to
 * draft the content.
 */
export function extractProposedContent(body: string): string | null {
  const headerRe = /^###\s+Proposed\s+node\s+content\s*$/m;
  const headerMatch = body.match(headerRe);
  if (!headerMatch || headerMatch.index === undefined) return null;
  const after = body.slice(headerMatch.index + headerMatch[0].length);
  // The "Proposed node content" section often starts with a YAML
  // frontmatter fence (`---` on its own line) and ends with a footer
  // separator (another `---`). We want to stop at the *footer*, not
  // the frontmatter close. Strategy: find the last `---` line in
  // `after` and treat it as the footer terminator. If only one
  // `---` exists, treat it as frontmatter (no terminator) and return
  // everything through end-of-body; if zero exist, same.
  const sepRe = /^\s*---\s*$/gm;
  const seps: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = sepRe.exec(after)) !== null) {
    seps.push(m.index);
  }
  let sliceEnd = after.length;
  if (seps.length >= 3) {
    // frontmatter open, frontmatter close, footer
    sliceEnd = seps[seps.length - 1];
  } else if (seps.length === 1) {
    // single `---` is almost certainly the footer (no frontmatter)
    sliceEnd = seps[0];
  }
  // seps.length === 0 or 2 → no discernible footer; keep full slice.
  // For 2 the common case is frontmatter open+close with no footer,
  // which means the content runs to EOF.
  const raw = after.slice(0, sliceEnd);
  const trimmed = raw.replace(/^\n+/, "").replace(/\s+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

export function draftBranchName(proposalId: string): string {
  return `first-tree/draft-node-${proposalId}`;
}

export function draftCommitMessage(node: string, proposalId: string): string {
  return `chore(tree): draft ${node} from proposal ${proposalId}`;
}

export function draftPrTitle(node: string): string {
  return `[gardener] draft ${node}`;
}

export function draftPrBody(params: {
  issueNumber: number;
  treeRepo: string;
  marker: ProposalMarker;
}): string {
  const { issueNumber, treeRepo, marker } = params;
  const sourceLine = marker.sourcePr
    ? `**Source PR:** ${marker.sourcePr}`
    : `**Source SHA:** ${marker.sourceSha}`;
  return [
    `Drafted from ${treeRepo}#${issueNumber} (proposal \`${marker.proposalId}\`).`,
    "",
    sourceLine,
    "",
    `Closes ${treeRepo}#${issueNumber} on merge.`,
    "",
    "---",
    "",
    `<sub>Auto-drafted by \`first-tree gardener draft-node\` (#277). Review the node content before merging.</sub>`,
  ].join("\n");
}

function defaultShellRun(): ShellRun {
  return async (command, args, options) => {
    try {
      const res = await execFileAsync(command, args, {
        cwd: options?.cwd,
        timeout: options?.timeout,
        env: options?.env ?? process.env,
        maxBuffer: 50 * 1024 * 1024,
      });
      return {
        stdout: String(res.stdout ?? ""),
        stderr: String(res.stderr ?? ""),
        code: 0,
      };
    } catch (err) {
      const error = err as NodeJS.ErrnoException & {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        code?: number | string;
      };
      return {
        stdout: error.stdout ? String(error.stdout) : "",
        stderr: error.stderr ? String(error.stderr) : String(error.message ?? ""),
        code: typeof error.code === "number" ? error.code : 1,
      };
    }
  };
}

function emitBreezeResult(
  write: (line: string) => void,
  status: DraftNodeStatus,
  summary: string,
): void {
  const compact = summary.replace(/\s+/g, " ").trim() || "no-op";
  write(`BREEZE_RESULT: status=${status} summary=${compact}`);
}

async function fetchIssueBody(
  shell: ShellRun,
  treeRepo: string,
  issue: number,
  env: NodeJS.ProcessEnv,
): Promise<{ body: string; error?: string }> {
  const res = await shell(
    "gh",
    ["issue", "view", String(issue), "--repo", treeRepo, "--json", "body", "-q", ".body"],
    { env },
  );
  if (res.code !== 0) {
    return { body: "", error: res.stderr.trim() || `gh issue view exited ${res.code}` };
  }
  return { body: res.stdout };
}

async function resolveTreeSlug(
  shell: ShellRun,
  treeRoot: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  const res = await shell(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    { cwd: treeRoot, env },
  );
  if (res.code !== 0) return null;
  const slug = res.stdout.trim();
  return slug.length > 0 ? slug : null;
}

async function checkoutDraftBranch(
  shell: ShellRun,
  treeRoot: string,
  branch: string,
): Promise<{ error?: string }> {
  const localBranch = await shell("git", ["rev-parse", "--verify", branch], {
    cwd: treeRoot,
  });
  if (localBranch.code === 0) {
    const checkoutLocal = await shell("git", ["checkout", branch], {
      cwd: treeRoot,
    });
    if (checkoutLocal.code !== 0) {
      return { error: checkoutLocal.stderr.trim() || "git checkout failed" };
    }
    return {};
  }

  const fetchRemote = await shell("git", ["fetch", "origin", branch], {
    cwd: treeRoot,
  });
  if (fetchRemote.code === 0) {
    const checkoutRemote = await shell(
      "git",
      ["checkout", "-B", branch, "FETCH_HEAD"],
      { cwd: treeRoot },
    );
    if (checkoutRemote.code !== 0) {
      return { error: checkoutRemote.stderr.trim() || "git checkout failed" };
    }
    return {};
  }

  if (
    !/couldn't find remote ref|could not find remote branch|remote ref does not exist/i.test(
      fetchRemote.stderr,
    )
  ) {
    return { error: fetchRemote.stderr.trim() || "git fetch failed" };
  }

  const checkoutNew = await shell("git", ["checkout", "-B", branch], {
    cwd: treeRoot,
  });
  if (checkoutNew.code !== 0) {
    return { error: checkoutNew.stderr.trim() || "git checkout failed" };
  }
  return {};
}

export async function runDraftNode(
  args: string[],
  deps: DraftNodeDeps = {},
): Promise<number> {
  const write = deps.write ?? ((line: string) => console.log(line));
  const shell = deps.shell ?? defaultShellRun();
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();

  const flags = parseFlags(args);
  if (flags.help) {
    write(DRAFT_NODE_USAGE);
    emitBreezeResult(write, "skipped", "help requested");
    return 0;
  }
  if (flags.unknown) {
    write(`\u274C ${flags.unknown}`);
    write(DRAFT_NODE_USAGE);
    emitBreezeResult(write, "failed", `bad flag: ${flags.unknown}`);
    return 1;
  }
  if (!flags.issue) {
    write(`\u274C --issue <n> is required`);
    write(DRAFT_NODE_USAGE);
    emitBreezeResult(write, "failed", "missing --issue");
    return 1;
  }

  const treeRoot = flags.treePath ? resolve(cwd, flags.treePath) : cwd;

  const token = env.TREE_REPO_TOKEN;
  if (!token) {
    write(`\u26A0 TREE_REPO_TOKEN unset — refusing to act on tree repo`);
    emitBreezeResult(write, "skipped", "TREE_REPO_TOKEN unset");
    return 0;
  }
  const tokenEnv: NodeJS.ProcessEnv = { ...env, GH_TOKEN: token };

  const treeRepo = flags.treeRepo ?? (await resolveTreeSlug(shell, treeRoot, tokenEnv));
  if (!treeRepo) {
    write(`\u274C could not resolve tree repo slug (pass --tree-repo)`);
    emitBreezeResult(write, "failed", "tree-repo unresolved");
    return 1;
  }

  write(`\u2712 draft-node: ${treeRepo}#${flags.issue}`);

  const fetched = await fetchIssueBody(shell, treeRepo, flags.issue, tokenEnv);
  if (fetched.error) {
    write(`\u274C failed to fetch issue: ${fetched.error}`);
    emitBreezeResult(write, "failed", `gh issue view: ${fetched.error}`);
    return 1;
  }
  const marker = parseProposalMarker(fetched.body);
  if (!marker) {
    write(`\u26A0 no gardener:sync-proposal marker found on ${treeRepo}#${flags.issue} \u2014 skipping`);
    emitBreezeResult(write, "skipped", "no sync-proposal marker");
    return 0;
  }
  write(`  proposal_id=${marker.proposalId} node=${marker.node} source=${marker.source ?? "sync"}`);

  const proposedContent = extractProposedContent(fetched.body);
  if (!proposedContent) {
    write(
      `\u26A0 issue has marker but no "### Proposed node content" section ` +
        `(likely a merged-PR issue) \u2014 deferring to human`,
    );
    emitBreezeResult(write, "skipped", "no proposed content in body");
    return 0;
  }

  const nodePath = join(treeRoot, marker.node, "NODE.md");
  const branch = draftBranchName(marker.proposalId);

  if (flags.dryRun) {
    write(`  would write: ${nodePath}`);
    write(`  would branch: ${branch}`);
    write(`  would commit: ${draftCommitMessage(marker.node, marker.proposalId)}`);
    write(`  would open PR titled: ${draftPrTitle(marker.node)}`);
    emitBreezeResult(write, "skipped", `dry-run: ${marker.node}`);
    return 0;
  }

  const checkoutRes = await checkoutDraftBranch(shell, treeRoot, branch);
  if (checkoutRes.error) {
    write(`\u274C git checkout failed: ${checkoutRes.error}`);
    emitBreezeResult(write, "failed", "git checkout");
    return 1;
  }

  mkdirSync(dirname(nodePath), { recursive: true });
  // Preserve existing frontmatter if the NODE.md already exists. For
  // v1 we just overwrite with the proposed content; the classifier
  // supplies a full body including frontmatter. If that changes,
  // this is the place to splice.
  const body = proposedContent.endsWith("\n") ? proposedContent : `${proposedContent}\n`;
  writeFileSync(nodePath, body);

  const addRes = await shell("git", ["add", nodePath], { cwd: treeRoot });
  if (addRes.code !== 0) {
    write(`\u274C git add failed: ${addRes.stderr.trim()}`);
    emitBreezeResult(write, "failed", "git add");
    return 1;
  }
  const stagedCheck = await shell("git", ["diff", "--cached", "--quiet"], {
    cwd: treeRoot,
  });
  if (stagedCheck.code === 0) {
    write(`\u2713 ${marker.node}: content already applied \u2014 nothing to commit`);
    emitBreezeResult(write, "skipped", `already-applied: ${marker.node}`);
    return 0;
  }
  const commitRes = await shell(
    "git",
    ["commit", "-m", draftCommitMessage(marker.node, marker.proposalId)],
    { cwd: treeRoot },
  );
  if (commitRes.code !== 0) {
    write(`\u274C git commit failed: ${commitRes.stderr.trim()}`);
    emitBreezeResult(write, "failed", "git commit");
    return 1;
  }

  const prResult = await openTreePr(shell, treeRoot, {
    branch,
    title: draftPrTitle(marker.node),
    body: draftPrBody({
      issueNumber: flags.issue,
      treeRepo,
      marker,
    }),
    labels: ["first-tree:draft-node"],
    env: tokenEnv,
  });
  if (!prResult.success) {
    write(`\u274C openTreePr failed: ${prResult.error ?? "unknown"}`);
    emitBreezeResult(write, "failed", `openTreePr: ${prResult.error ?? "unknown"}`);
    return 1;
  }
  write(`\u2713 opened tree PR: ${prResult.prUrl ?? "(url unknown)"}`);
  emitBreezeResult(
    write,
    "handled",
    `drafted ${marker.node} \u2192 ${prResult.prUrl ?? "(pr)"}`,
  );
  return 0;
}
