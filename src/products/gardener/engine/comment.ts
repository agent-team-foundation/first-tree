/**
 * gardener-comment — port of `gardener-comment-manual.md` runbook.
 *
 * Reviews open PRs and issues on a source repo against a Context Tree
 * and posts structured verdict comments (ALIGNED / NEW_TERRITORY /
 * NEEDS_REVIEW / CONFLICT / INSUFFICIENT_CONTEXT) with severity
 * levels and tree-node citations.
 *
 * This TypeScript port preserves the runbook byte-for-byte where the
 * runbook is specific. Marker formats, command recognition regexes,
 * comment templates, and state-resolution rules match the runbook.
 *
 * Dual-path execution:
 *   - When `$BREEZE_SNAPSHOT_DIR` is set, reads pre-fetched data from
 *     JSON files in that directory (pr-view.json, pr.diff,
 *     issue-view.json, issue-comments.json, subject.json).
 *   - Otherwise, calls `gh api` / `gh pr …` / `gh issue …` to fetch
 *     data live.
 *
 * Config opt-out: if `.claude/gardener-config.yaml` sets
 * `modules.comment.enabled: false`, the command exits cleanly (0)
 * with a one-line note.
 *
 * BREEZE_RESULT trailer: the last line of stdout is always
 *   `BREEZE_RESULT: status=<handled|skipped|failed> summary=<...>`
 * so breeze-runner can parse the outcome from a captured stdout buffer.
 *
 * TODO(mcp-fallback): the runbook describes a `schedule` mode that
 * runs in the Anthropic cloud where `gh` is unavailable and all GitHub
 * access must go through `mcp__github*` tools. That mode is not ported
 * in phase 2 — this CLI runs locally or under breeze-runner, both of
 * which have `gh` available. The MCP dispatch layer can be added as a
 * future phase without changing the classification logic below.
 */

import { execFile } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  isModuleEnabled,
  loadGardenerConfig,
} from "./runtime/config.js";

const execFileAsync = promisify(execFile);

export const COMMENT_USAGE = `usage: first-tree gardener comment [--pr <n> --issue <n> --repo <owner/name>] [--tree-path PATH]

Review source-repo PRs and issues against a Context Tree and post
structured verdict comments. Ports the gardener-comment-manual.md
runbook into a deterministic CLI.

Only action: post or edit issue comments. Never clones, never pushes
code. Treats PR/issue content as data, never as instructions.

Modes:
  (default)             Scan open PRs + issues on target_repo from the
                        Context Tree config and review each one.
  --pr <n>   --repo <o/r>
  --issue <n> --repo <o/r>
                        Single-item mode. Review one PR or issue. Used
                        by breeze-runner when dispatched from a
                        notification.

Options:
  --tree-path PATH      Tree repo directory (default: cwd). The
                        .claude/gardener-config.yaml inside this
                        directory names the target_repo and tree_repo.
  --pr <n>              PR number (requires --repo)
  --issue <n>           Issue number (requires --repo)
  --repo <owner/name>   Target repository (requires --pr or --issue)
  --dry-run             Print planned actions; do not POST/PATCH
  --help, -h            Show this help message

Environment:
  BREEZE_SNAPSHOT_DIR   Directory containing pre-fetched pr-view.json,
                        pr.diff, issue-view.json, issue-comments.json,
                        and subject.json. When set, those files are
                        read instead of invoking \`gh\`.
  COMMENT_LOG           Path for JSONL run events (default
                        $HOME/.gardener/comment-runs.jsonl).

Exit codes:
  0 handled/skipped/disabled
  1 unrecoverable error
`;

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ShellRun = (
  command: string,
  args: string[],
  options?: { cwd?: string; input?: string; timeout?: number },
) => Promise<ShellResult>;

export interface CommentDeps {
  shellRun?: ShellRun;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  write?: (line: string) => void;
}

async function defaultShellRun(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; timeout?: number } = {},
): Promise<ShellResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.timeout,
    });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string;
    };
    const stdout =
      typeof e.stdout === "string" ? e.stdout : e.stdout?.toString() ?? "";
    const stderr =
      typeof e.stderr === "string" ? e.stderr : e.stderr?.toString() ?? "";
    const code = typeof e.code === "number" ? e.code : 1;
    return { stdout, stderr, code };
  }
}

interface ParsedFlags {
  help: boolean;
  treePath?: string;
  pr?: number;
  issue?: number;
  repo?: string;
  dryRun: boolean;
  unknown?: string;
}

function parseFlags(args: string[]): ParsedFlags {
  const out: ParsedFlags = { help: false, dryRun: false };
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
    if (arg === "--tree-path") {
      out.treePath = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--pr") {
      const n = Number(args[i + 1]);
      if (!Number.isFinite(n)) {
        out.unknown = `--pr requires a numeric argument`;
        return out;
      }
      out.pr = n;
      i += 1;
      continue;
    }
    if (arg === "--issue") {
      const n = Number(args[i + 1]);
      if (!Number.isFinite(n)) {
        out.unknown = `--issue requires a numeric argument`;
        return out;
      }
      out.issue = n;
      i += 1;
      continue;
    }
    if (arg === "--repo") {
      out.repo = args[i + 1];
      i += 1;
      continue;
    }
    out.unknown = arg;
    return out;
  }
  return out;
}

export type CommentStatus = "handled" | "skipped" | "failed" | "disabled";

export type Verdict =
  | "ALIGNED"
  | "NEW_TERRITORY"
  | "NEEDS_REVIEW"
  | "CONFLICT"
  | "INSUFFICIENT_CONTEXT";

export type Severity = "low" | "medium" | "high" | "critical";

export type ItemType = "pr" | "issue";

export interface PrView {
  number: number;
  title?: string;
  body?: string;
  headRefName?: string;
  headRefOid?: string;
  state?: string;
  author?: { login?: string } | string;
  additions?: number;
  deletions?: number;
  labels?: { name: string }[] | string[];
  updatedAt?: string;
}

export interface IssueView {
  number: number;
  title?: string;
  body?: string;
  state?: string;
  author?: { login?: string } | string;
  labels?: { name: string }[] | string[];
  updatedAt?: string;
}

export interface IssueComment {
  id?: number;
  user?: { login?: string };
  body?: string;
  created_at?: string;
  updated_at?: string;
}

export interface SubjectMetadata {
  /** The authenticated gardener user login (e.g. the bot account). */
  gardenerUser?: string;
  /** Item type (`pr` or `issue`) when the snapshot is for a single item. */
  type?: ItemType;
  /** Source repo slug when different from the config target_repo. */
  repo?: string;
  /** Pre-computed tree SHA for the snapshot run. */
  treeSha?: string;
  /** Pre-computed tree repo URL for footer attribution. */
  treeRepoUrl?: string;
}

export interface SnapshotBundle {
  subject: SubjectMetadata;
  type: ItemType;
  prView?: PrView;
  issueView?: IssueView;
  diff?: string;
  issueComments: IssueComment[];
}

// ───────────────────────── Marker / regex primitives ────────────────────────

export const GARDENER_STATE_MARKER_RE = /<!--\s*gardener:state[^>]*-->/;
export const GARDENER_IGNORED_MARKER_RE = /<!--\s*gardener:ignored\s*-->/;
export const GARDENER_PAUSED_MARKER_RE = /<!--\s*gardener:paused\s*-->/;
export const GARDENER_LAST_CONSUMED_RE =
  /gardener:last_consumed_rereview=(\d+)/;
export const REVIEWED_SHA_RE = /reviewed=([A-Za-z0-9@:.-]+)/;
export const VERDICT_IN_MARKER_RE = /verdict=([A-Z_]+)/;
export const SEVERITY_IN_MARKER_RE = /severity=([a-z]+)/;
export const TREE_SHA_IN_MARKER_RE = /tree_sha=([A-Za-z0-9]+)/;

/**
 * Recognizes `@gardener <command>` in user comments. Matches the
 * runbook regex exactly so the CLI sees the same command set the
 * runbook describes. The state marker's footer includes this same
 * phrase but in a `<sub>` block; callers MUST exclude gardener's own
 * comments (by author) before running this match to avoid the
 * self-loop described in the runbook's Step 2 "Critical" note.
 */
export const GARDENER_COMMAND_RE = /@gardener (re-review|pause|resume|ignore)/;

/** Severity strings gardener recognises, in ascending severity order. */
export const SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];

/** Verdicts gardener recognises, in runbook order. */
export const VERDICTS: Verdict[] = [
  "ALIGNED",
  "NEW_TERRITORY",
  "NEEDS_REVIEW",
  "CONFLICT",
  "INSUFFICIENT_CONTEXT",
];

const VERDICT_EMOJI: Record<Verdict, string> = {
  ALIGNED: "✅",
  NEW_TERRITORY: "🆕",
  NEEDS_REVIEW: "🔍",
  CONFLICT: "⚠️",
  INSUFFICIENT_CONTEXT: "❔",
};

const FIT_CELL: Record<Verdict, string> = {
  ALIGNED: "✅ Aligned",
  NEW_TERRITORY: "🆕 New",
  NEEDS_REVIEW: "❓ Partial",
  CONFLICT: "⚠️ Conflict",
  INSUFFICIENT_CONTEXT: "❔ Insufficient",
};

// ───────────────────────── Body helpers ─────────────────────────

function authorLogin(author: PrView["author"] | IssueView["author"]): string | undefined {
  if (!author) return undefined;
  if (typeof author === "string") return author;
  return author.login;
}

function labelNames(
  labels: PrView["labels"] | IssueView["labels"] | undefined,
): string[] {
  if (!labels) return [];
  return labels.map((l) => (typeof l === "string" ? l : l?.name ?? ""))
    .filter((n): n is string => n.length > 0);
}

export function hasReviewedLabel(
  view: Pick<PrView, "labels"> | Pick<IssueView, "labels"> | undefined,
): boolean {
  if (!view) return false;
  return labelNames(view.labels).includes("gardener:reviewed");
}

/**
 * Extract the `gardener:state` marker line — the full `<!-- … -->`
 * comment (not just the inside). Returns null when no marker is
 * present. Used when re-constructing a PATCHed comment body so the
 * HTML comment is preserved verbatim.
 */
export function extractStateMarker(body: string | undefined): string | null {
  if (!body) return null;
  const match = body.match(GARDENER_STATE_MARKER_RE);
  return match ? match[0] : null;
}

/**
 * Parse the inner fields of a `gardener:state` marker. Returns null
 * when the marker is missing or unparseable.
 */
export function parseStateMarker(body: string | undefined): {
  reviewed?: string;
  verdict?: Verdict;
  severity?: Severity;
  treeSha?: string;
} | null {
  const marker = extractStateMarker(body);
  if (!marker) return null;
  const out: {
    reviewed?: string;
    verdict?: Verdict;
    severity?: Severity;
    treeSha?: string;
  } = {};
  const reviewed = marker.match(REVIEWED_SHA_RE);
  if (reviewed) out.reviewed = reviewed[1];
  const verdict = marker.match(VERDICT_IN_MARKER_RE);
  if (verdict && VERDICTS.includes(verdict[1] as Verdict)) {
    out.verdict = verdict[1] as Verdict;
  }
  const severity = marker.match(SEVERITY_IN_MARKER_RE);
  if (severity && SEVERITIES.includes(severity[1] as Severity)) {
    out.severity = severity[1] as Severity;
  }
  const treeSha = marker.match(TREE_SHA_IN_MARKER_RE);
  if (treeSha) out.treeSha = treeSha[1];
  return out;
}

export function hasIgnoredMarker(body: string | undefined): boolean {
  if (!body) return false;
  return GARDENER_IGNORED_MARKER_RE.test(body);
}

export function hasPausedMarker(body: string | undefined): boolean {
  if (!body) return false;
  return GARDENER_PAUSED_MARKER_RE.test(body);
}

export function readLastConsumedRereview(
  body: string | undefined,
): number | null {
  if (!body) return null;
  const match = body.match(GARDENER_LAST_CONSUMED_RE);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Compare two SHAs using prefix match so older 8-char markers still
 * count as "same commit". Returns false if either input is empty.
 */
export function shaMatches(
  head: string | undefined | null,
  marker: string | undefined | null,
): boolean {
  if (!head || !marker) return false;
  if (head === marker) return true;
  if (marker.length < head.length) return head.startsWith(marker);
  return marker.startsWith(head);
}

// ───────────────────────── State resolution ─────────────────────────

/**
 * Which gardener comment (by id) to act on, and how. The caller
 * uses this to decide whether to POST a new comment, PATCH an
 * existing one, or skip the item entirely.
 */
export type StateAction =
  | { kind: "skip"; reason: string }
  | { kind: "first_review" }
  | {
      kind: "rereview";
      /** The id of the gardener:state comment to PATCH. */
      commentId: number;
      /** The id of the `@gardener re-review` comment, if this was triggered by one. */
      consumedRereviewId?: number;
      reason: string;
    };

export interface ResolveStateInput {
  /** All comments on the item (already paginated into one flat array). */
  comments: IssueComment[];
  /** Login of the authenticated gardener user (for self-exclusion). */
  gardenerUser: string;
  /** HEAD SHA for PRs. For issues, pass `updatedAt` from issue-view. */
  headIdentifier?: string;
  /** Whether the item has the `gardener:reviewed` label set. */
  hasReviewedLabel: boolean;
}

/**
 * Resolve the action gardener should take on an item based on prior
 * comments. Implements the runbook's Step 2 rules 1–5b in order:
 *
 *   1. gardener:ignored → skip forever
 *   2. gardener:paused and no newer @gardener resume → skip
 *   3. @gardener re-review not yet consumed → rereview
 *   4. gardener:state sha matches head → skip; differs → rereview
 *   5. gardener:reviewed label present, no new activity → skip
 *   6. No state/label → first_review
 *
 * The runbook's rule 5 "issue infinite-loop" guard is handled in the
 * caller (it needs the timeline API); here we treat issues the same
 * as PRs: if the marker `reviewed=` value does not match the passed
 * `headIdentifier`, we re-review.
 */
export function resolveState(input: ResolveStateInput): StateAction {
  const { comments, gardenerUser, headIdentifier, hasReviewedLabel } = input;

  // Find gardener's own comments (state comments) and user commands.
  // A comment is "from gardener" if EITHER the login matches OR the
  // body carries a `<!-- gardener:` HTML marker (marker fallback handles
  // comments authored under a different bot identity — self-loop guard
  // from first-tree#134 / repo-gardener#22).
  const hasGardenerMarker = (body: string | undefined): boolean =>
    typeof body === "string" && /<!--\s*gardener:/.test(body);
  const gardenerComments = comments.filter(
    (c) =>
      (c.user?.login === gardenerUser || hasGardenerMarker(c.body)) &&
      c.body &&
      c.body.length > 0,
  );
  const userCommands = comments.filter(
    (c) =>
      c.user?.login !== gardenerUser &&
      !hasGardenerMarker(c.body) &&
      typeof c.body === "string" &&
      GARDENER_COMMAND_RE.test(c.body),
  );

  // Rule 1: ignored.
  for (const c of gardenerComments) {
    if (hasIgnoredMarker(c.body)) {
      return { kind: "skip", reason: "ignored marker present" };
    }
  }

  // Rule 2: paused (with resume override).
  const latestByCmd = (cmd: "pause" | "resume"): string | null => {
    let latest: string | null = null;
    const re = new RegExp(`@gardener ${cmd}\\b`);
    for (const c of userCommands) {
      if (!c.body || !c.created_at) continue;
      if (!re.test(c.body)) continue;
      if (!latest || c.created_at > latest) latest = c.created_at;
    }
    return latest;
  };

  const hasPausedState = gardenerComments.some((c) => hasPausedMarker(c.body));
  if (hasPausedState) {
    const lastPause = latestByCmd("pause");
    const lastResume = latestByCmd("resume");
    if (lastPause && (!lastResume || lastResume <= lastPause)) {
      return { kind: "skip", reason: "paused by user" };
    }
    // else fall through to rule 4 — resume is active.
  }

  // Rule 3: @gardener re-review — find newest re-review command and
  // check the last_consumed_rereview marker on the latest state
  // comment.
  const rereviewRe = /@gardener re-review\b/;
  const latestRereview = userCommands
    .filter((c) => c.body && rereviewRe.test(c.body) && c.id !== undefined)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
    .pop();

  // The "latest" gardener:state comment — by created_at descending.
  const latestState = gardenerComments
    .filter((c) => extractStateMarker(c.body) !== null)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
    .pop();

  if (latestRereview && latestRereview.id !== undefined) {
    const consumed = latestState
      ? readLastConsumedRereview(latestState.body)
      : null;
    if (consumed !== latestRereview.id) {
      return {
        kind: "rereview",
        commentId: latestState?.id ?? 0,
        consumedRereviewId: latestRereview.id,
        reason: `@gardener re-review #${latestRereview.id}`,
      };
    }
    // else: already consumed, fall through.
  }

  // Rule 4: gardener:state sha comparison.
  if (latestState) {
    const parsed = parseStateMarker(latestState.body);
    const markerSha = parsed?.reviewed;
    if (markerSha && shaMatches(headIdentifier, markerSha)) {
      return { kind: "skip", reason: "state sha matches head" };
    }
    if (latestState.id !== undefined) {
      return {
        kind: "rereview",
        commentId: latestState.id,
        reason: "state sha differs from head",
      };
    }
  }

  // Rule 5b: gardener:reviewed label and no new activity.
  if (hasReviewedLabel) {
    // We can't prove staleness without timeline data; conservative
    // default is to skip (silent-aligned still valid). Callers can
    // force a re-review by removing the label.
    return { kind: "skip", reason: "gardener:reviewed label present" };
  }

  // Rule 6: first review.
  return { kind: "first_review" };
}

// ───────────────────────── Classification (verdict) ────────────────

export interface ClassifyInput {
  type: ItemType;
  prView?: PrView;
  issueView?: IssueView;
  diff?: string;
  treeRoot: string;
  treeSha?: string;
}

export interface ClassifyOutput {
  verdict: Verdict;
  severity: Severity;
  /** One-line summary written into the comment body. */
  summary: string;
  /** Tree nodes cited in the comment body. */
  treeNodes: Array<{ path: string; summary: string }>;
}

/**
 * Classifier hook. The real verdict is a judgment call that belongs
 * to an LLM (matching the runbook's "this is a judgment, not a pattern
 * match" guidance). This default returns `NEW_TERRITORY` with low
 * severity so the deterministic scaffolding is exercisable in tests
 * and in CI without LLM access. Callers that want real verdicts
 * should inject a classifier that reads the diff and the tree.
 */
export type Classifier = (input: ClassifyInput) => Promise<ClassifyOutput>;

export const defaultClassifier: Classifier = async () => ({
  verdict: "NEW_TERRITORY",
  severity: "low",
  summary: "Tree guidance not yet available for this area.",
  treeNodes: [],
});

// ───────────────────────── Comment body construction ─────────────

export interface BuildCommentInput {
  verdict: Verdict;
  severity: Severity;
  summary: string;
  treeNodes: Array<{ path: string; summary: string }>;
  /** Short form of the reviewed commit / issue timestamp. */
  reviewedShort: string;
  /** Full 40-char SHA or `issue@<iso>` for the marker. */
  reviewedFull: string;
  /** Full tree SHA for the marker. */
  treeSha: string;
  /** Short form of the tree SHA for the footer. */
  treeShaShort: string;
  /** The re-review comment id we're consuming, if any. */
  consumedRereviewId?: number;
  /** Tree repo URL for footer attribution. */
  treeRepoUrl?: string;
  /** Tree owner/name slug for footer attribution. */
  treeSlug?: string;
  /** Whether this is for a PR (controls table header wording). */
  itemType: ItemType;
}

export function buildCommentBody(input: BuildCommentInput): string {
  const {
    verdict,
    severity,
    summary,
    treeNodes,
    reviewedShort,
    reviewedFull,
    treeSha,
    treeShaShort,
    consumedRereviewId,
    treeRepoUrl,
    treeSlug,
    itemType,
  } = input;
  const emoji = VERDICT_EMOJI[verdict];
  const fitCell = FIT_CELL[verdict];
  const isMinimalAligned = verdict === "ALIGNED" && severity === "low";
  const consumedId =
    consumedRereviewId !== undefined ? String(consumedRereviewId) : "none";
  const headerLabel = itemType === "pr" ? "This PR" : "This PR/Issue";
  const treeUrl = treeRepoUrl ?? "";
  const treeNodeLinks =
    treeNodes.length > 0
      ? treeNodes
          .map(
            (n) =>
              `- [\`${n.path}\`](${treeUrl}/blob/main/${n.path}) — ${n.summary}`,
          )
          .join("\n")
      : `- _(no tree nodes cited — tree may be empty or irrelevant to this change)_`;
  const markerLine1 = `<!-- gardener:state · reviewed=${reviewedFull} · verdict=${verdict} · severity=${severity} · tree_sha=${treeSha} -->`;
  const markerLine2 = `<!-- gardener:last_consumed_rereview=${consumedId} -->`;

  const detailsOpen = isMinimalAligned ? "<details>" : "<details open>";
  const closing = isMinimalAligned
    ? `No concerns. ${summary}`
    : `### Recommendation\n\n**Why:** ${summary}\n\n**Suggested path forward:** _See the tree nodes cited above for the decision this touches._`;

  const treeSlugLine = treeSlug && treeRepoUrl
    ? `Reviews this repo against [${treeSlug}](${treeRepoUrl}), a user-maintained context tree. Not affiliated with this project's maintainers.`
    : "Reviews this repo against a user-maintained context tree. Not affiliated with this project's maintainers.";

  const lines = [
    markerLine1,
    markerLine2,
    "",
    `🌱 **gardener** · ${emoji} \`${verdict}\` · severity: \`${severity}\` · commit: \`${reviewedShort}\``,
    "",
    "> **What is this?** repo-gardener checks whether PRs and issues fit the project's **product decisions, architecture, and roadmap** — not code correctness. Think of it as a product-context review layer. For code review, see Greptile/CodeRabbit.",
    "",
    "### Context fit",
    "",
    detailsOpen,
    "<summary><strong>Context match</strong></summary>",
    "",
    `| Area | ${headerLabel} | Tree guidance | Fit |`,
    "|------|---------------|---------------|-----|",
    `| overall | ${summary} | ${treeNodes[0]?.summary ?? "(none cited)"} | ${fitCell} |`,
    "",
    "</details>",
    "",
    "<details>",
    "<summary><strong>Tree nodes referenced</strong></summary>",
    "",
    treeNodeLinks,
    "",
    "</details>",
    "",
    closing,
    "",
    "---",
    "",
    `<sub>Reviewed commit: <code>${reviewedShort}</code> · Tree snapshot: <code>${treeShaShort}</code> · Commands: <code>@gardener re-review</code> · <code>@gardener pause</code> · <code>@gardener ignore</code></sub>`,
    "",
    `<sub>🌱 Posted by [repo-gardener](https://github.com/agent-team-foundation/repo-gardener) — an open-source context-aware review bot built on [First-Tree](https://github.com/agent-team-foundation/first-tree). ${treeSlugLine}</sub>`,
  ];
  return lines.join("\n");
}

// ───────────────────────── Snapshot / gh I/O ─────────────────────

function jsonTryParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Read a snapshot bundle from `$BREEZE_SNAPSHOT_DIR`. Returns null if
 * required files are missing — caller should fall back to live gh
 * fetches. Required files depend on the type:
 *   - PR: `pr-view.json`, `pr.diff`, `issue-comments.json`
 *   - Issue: `issue-view.json`, `issue-comments.json`
 * `subject.json` is optional and supplies gardener user + tree SHA.
 */
export function readSnapshot(dir: string): SnapshotBundle | null {
  const prViewPath = join(dir, "pr-view.json");
  const issueViewPath = join(dir, "issue-view.json");
  const commentsPath = join(dir, "issue-comments.json");
  const diffPath = join(dir, "pr.diff");
  const subjectPath = join(dir, "subject.json");

  const subject = existsSync(subjectPath)
    ? jsonTryParse<SubjectMetadata>(readFileSync(subjectPath, "utf-8")) ?? {}
    : {};

  const issueComments = existsSync(commentsPath)
    ? jsonTryParse<IssueComment[]>(readFileSync(commentsPath, "utf-8")) ?? []
    : [];

  if (existsSync(prViewPath)) {
    const prView = jsonTryParse<PrView>(readFileSync(prViewPath, "utf-8"));
    if (!prView) return null;
    const diff = existsSync(diffPath) ? readFileSync(diffPath, "utf-8") : "";
    return {
      subject,
      type: "pr",
      prView,
      diff,
      issueComments,
    };
  }

  if (existsSync(issueViewPath)) {
    const issueView = jsonTryParse<IssueView>(
      readFileSync(issueViewPath, "utf-8"),
    );
    if (!issueView) return null;
    return {
      subject,
      type: "issue",
      issueView,
      issueComments,
    };
  }

  return null;
}

async function fetchPrBundle(
  shell: ShellRun,
  repo: string,
  pr: number,
): Promise<SnapshotBundle | null> {
  const viewRes = await shell("gh", [
    "pr",
    "view",
    String(pr),
    "--repo",
    repo,
    "--json",
    "number,title,body,headRefName,headRefOid,state,author,additions,deletions,labels,updatedAt",
  ]);
  if (viewRes.code !== 0) return null;
  const prView = jsonTryParse<PrView>(viewRes.stdout);
  if (!prView) return null;

  const commentsRes = await shell("gh", [
    "api",
    "--paginate",
    `/repos/${repo}/issues/${pr}/comments`,
  ]);
  const issueComments = commentsRes.code === 0
    ? jsonTryParse<IssueComment[]>(commentsRes.stdout) ?? []
    : [];

  const diffRes = await shell("gh", [
    "pr",
    "diff",
    String(pr),
    "--repo",
    repo,
  ]);
  const diff = diffRes.code === 0 ? diffRes.stdout : "";

  return { subject: {}, type: "pr", prView, diff, issueComments };
}

async function fetchIssueBundle(
  shell: ShellRun,
  repo: string,
  issue: number,
): Promise<SnapshotBundle | null> {
  const viewRes = await shell("gh", [
    "issue",
    "view",
    String(issue),
    "--repo",
    repo,
    "--json",
    "number,title,body,state,author,labels,updatedAt",
  ]);
  if (viewRes.code !== 0) return null;
  const issueView = jsonTryParse<IssueView>(viewRes.stdout);
  if (!issueView) return null;

  const commentsRes = await shell("gh", [
    "api",
    "--paginate",
    `/repos/${repo}/issues/${issue}/comments`,
  ]);
  const issueComments = commentsRes.code === 0
    ? jsonTryParse<IssueComment[]>(commentsRes.stdout) ?? []
    : [];

  return { subject: {}, type: "issue", issueView, issueComments };
}

async function fetchGardenerUser(
  shell: ShellRun,
): Promise<string | undefined> {
  const res = await shell("gh", ["api", "user", "--jq", ".login"]);
  if (res.code !== 0) return undefined;
  const login = res.stdout.trim();
  return login.length > 0 ? login : undefined;
}

// ───────────────────────── Logging + BREEZE_RESULT ───────────────

function commentLogPath(env: NodeJS.ProcessEnv): string {
  if (env.COMMENT_LOG && env.COMMENT_LOG.length > 0) return env.COMMENT_LOG;
  const home = env.HOME ?? env.USERPROFILE ?? process.cwd();
  return join(home, ".gardener", "comment-runs.jsonl");
}

function logEvent(
  env: NodeJS.ProcessEnv,
  event: Record<string, unknown>,
): void {
  try {
    const path = commentLogPath(env);
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...event,
    });
    appendFileSync(path, `${line}\n`);
  } catch {
    // Best-effort — never fail a run because of log IO.
  }
}

function emitBreezeResult(
  write: (line: string) => void,
  status: CommentStatus,
  summary: string,
): void {
  const compact = summary.replace(/\s+/g, " ").trim() || "no-op";
  write(`BREEZE_RESULT: status=${status} summary=${compact}`);
}

// ───────────────────────── Single-item review ─────────────────────

interface ReviewOneInput {
  repo: string;
  number: number;
  type: ItemType;
  treeRoot: string;
  dryRun: boolean;
  shell: ShellRun;
  env: NodeJS.ProcessEnv;
  write: (line: string) => void;
  now: () => Date;
  classifier: Classifier;
  treeRepoUrl?: string;
  treeSlug?: string;
  treeSha?: string;
}

async function reviewOne(
  opts: ReviewOneInput,
): Promise<{ status: CommentStatus; summary: string }> {
  const {
    repo,
    number,
    type,
    treeRoot,
    dryRun,
    shell,
    env,
    write,
    classifier,
    treeRepoUrl,
    treeSlug,
  } = opts;

  const snapshotDir = env.BREEZE_SNAPSHOT_DIR;
  const bundle = snapshotDir
    ? readSnapshot(snapshotDir)
    : type === "pr"
      ? await fetchPrBundle(shell, repo, number)
      : await fetchIssueBundle(shell, repo, number);

  if (!bundle) {
    const msg = `Could not load ${type} data for ${repo}#${number}`;
    write(msg);
    logEvent(env, { kind: "error", message: msg });
    return { status: "failed", summary: `fetch failed for ${repo}#${number}` };
  }

  // Self-loop guard: gardener-comment is for source-repo PRs, not for
  // gardener's own tree PRs. Tree PRs carry the `first-tree:sync` label
  // — skip them here so the comment module never posts a verdict on a
  // PR gardener opened. See: agent-team-foundation/first-tree#134,
  // repo-gardener#22.
  const prOrIssueView = type === "pr" ? bundle.prView : bundle.issueView;
  const labels = labelNames(prOrIssueView?.labels);
  if (labels.includes("first-tree:sync")) {
    const msg = `#${number} has first-tree:sync label — gardener-comment skips sync PRs to avoid self-loops`;
    write(`\u23ed ${msg}`);
    logEvent(env, {
      kind: "skip",
      number,
      reason: "first-tree:sync label",
    });
    return {
      status: "skipped",
      summary: `sync PR — not a comment-module target`,
    };
  }

  // Resolve gardener user: from subject, env, or gh.
  let gardenerUser = bundle.subject.gardenerUser;
  if (!gardenerUser) gardenerUser = env.GARDENER_USER;
  if (!gardenerUser) gardenerUser = await fetchGardenerUser(shell);
  if (!gardenerUser) {
    const msg = `Could not resolve gardener user (gh api user failed)`;
    write(msg);
    logEvent(env, { kind: "error", message: msg });
    return { status: "failed", summary: msg };
  }

  // Freshness guard — skip merged/closed items (Step 4-pre).
  const itemState = type === "pr"
    ? bundle.prView?.state
    : bundle.issueView?.state;
  if (type === "pr" && (itemState === "MERGED" || itemState === "CLOSED")) {
    const msg = `#${number}: ${itemState} since scan, skipping`;
    write(`\u23ed ${msg}`);
    logEvent(env, { kind: "skip", number, reason: "stale" });
    return { status: "skipped", summary: msg };
  }
  if (type === "issue" && (itemState === "closed" || itemState === "CLOSED")) {
    const msg = `#${number}: issue closed since scan, skipping`;
    write(`\u23ed ${msg}`);
    logEvent(env, { kind: "skip", number, reason: "stale" });
    return { status: "skipped", summary: msg };
  }

  // Resolve state (Step 2).
  const view = type === "pr" ? bundle.prView : bundle.issueView;
  // headIdentifier must match the reviewedFull marker format written below
  // (line ~1019). PRs use raw 40-char SHA; issues use `issue@<iso>` so that
  // `shaMatches` compares like-for-like and avoids re-reviewing on every scan.
  const headIdentifier = type === "pr"
    ? bundle.prView?.headRefOid
    : bundle.issueView?.updatedAt
      ? `issue@${bundle.issueView.updatedAt}`
      : undefined;
  const action = resolveState({
    comments: bundle.issueComments,
    gardenerUser,
    headIdentifier,
    hasReviewedLabel: hasReviewedLabel(view),
  });

  if (action.kind === "skip") {
    write(`\u23ed #${number}: ${action.reason}`);
    logEvent(env, { kind: "skip", number, reason: action.reason });
    return { status: "skipped", summary: action.reason };
  }

  // Classify (Step 4b).
  const classification = await classifier({
    type,
    prView: bundle.prView,
    issueView: bundle.issueView,
    diff: bundle.diff,
    treeRoot,
    treeSha: opts.treeSha ?? bundle.subject.treeSha,
  });

  const reviewedFull = type === "pr"
    ? bundle.prView?.headRefOid ?? "unknown"
    : `issue@${bundle.issueView?.updatedAt ?? ""}`;
  const reviewedShort = type === "pr"
    ? (bundle.prView?.headRefOid ?? "").slice(0, 8) || "unknown"
    : (bundle.issueView?.updatedAt ?? "").slice(0, 10) || "unknown";
  const treeSha = opts.treeSha ?? bundle.subject.treeSha ?? "unknown";
  const treeShaShort = treeSha === "unknown" ? "unknown" : treeSha.slice(0, 8);

  // Silent-aligned path (Step 4c) — ALIGNED + low + first review + no
  // consumed rereview + has write access. In the absence of a permission
  // probe we treat the presence of `ALIGNED` + `low` + first_review
  // without a re-review trigger as eligible for the label path.
  if (
    classification.verdict === "ALIGNED" &&
    classification.severity === "low" &&
    action.kind === "first_review"
  ) {
    const pr = bundle.prView;
    const large = pr &&
      (pr.additions ?? 0) + (pr.deletions ?? 0) > 500;
    if (!large) {
      write(
        `\u2713 #${number}: ALIGNED + low → applying gardener:reviewed label (silent path)`,
      );
      if (!dryRun) {
        const editCmd = type === "pr" ? "pr" : "issue";
        await shell("gh", [
          editCmd,
          "edit",
          String(number),
          "--repo",
          repo,
          "--add-label",
          "gardener:reviewed",
        ]);
      }
      logEvent(env, {
        kind: "item",
        number,
        type,
        verdict: "ALIGNED",
        severity: "low",
        silent_aligned: true,
      });
      return { status: "handled", summary: `silent-aligned #${number}` };
    }
    // large PRs fall through to minimal comment.
  }

  const body = buildCommentBody({
    verdict: classification.verdict,
    severity: classification.severity,
    summary: classification.summary,
    treeNodes: classification.treeNodes,
    reviewedShort,
    reviewedFull,
    treeSha,
    treeShaShort,
    consumedRereviewId:
      action.kind === "rereview" ? action.consumedRereviewId : undefined,
    treeRepoUrl,
    treeSlug,
    itemType: type,
  });

  if (action.kind === "rereview" && action.commentId > 0) {
    // PATCH existing comment (Step 4e).
    write(
      `\u2712 #${number}: re-review → PATCH comment ${action.commentId} (${classification.verdict})`,
    );
    if (!dryRun) {
      await shell("gh", [
        "api",
        "-X",
        "PATCH",
        `/repos/${repo}/issues/comments/${action.commentId}`,
        "-f",
        `body=${body}`,
      ]);
    }
    logEvent(env, {
      kind: "item",
      number,
      type,
      verdict: classification.verdict,
      severity: classification.severity,
      patched: true,
      comment_id: action.commentId,
    });
    return {
      status: "handled",
      summary: `patched #${number} verdict=${classification.verdict}`,
    };
  }

  // First review — POST new comment.
  write(
    `\u2713 #${number}: first review → POST (${classification.verdict}/${classification.severity})`,
  );
  if (!dryRun) {
    await shell("gh", [
      "api",
      "-X",
      "POST",
      `/repos/${repo}/issues/${number}/comments`,
      "-f",
      `body=${body}`,
    ]);
  }
  logEvent(env, {
    kind: "item",
    number,
    type,
    verdict: classification.verdict,
    severity: classification.severity,
    patched: false,
  });
  return {
    status: "handled",
    summary: `posted #${number} verdict=${classification.verdict}`,
  };
}

// ───────────────────────── Scan mode ─────────────────────────

async function runScan(opts: {
  treeRoot: string;
  dryRun: boolean;
  shell: ShellRun;
  env: NodeJS.ProcessEnv;
  write: (line: string) => void;
  now: () => Date;
  classifier: Classifier;
  targetRepo: string;
  treeRepoUrl?: string;
  treeSlug?: string;
  treeSha?: string;
}): Promise<{ status: CommentStatus; summary: string }> {
  const { shell, write, env, targetRepo } = opts;

  const prsRes = await shell("gh", [
    "pr",
    "list",
    "--repo",
    targetRepo,
    "--state",
    "open",
    "--limit",
    "30",
    "--json",
    "number,title,headRefName,headRefOid,state,author,additions,deletions,labels,updatedAt",
  ]);
  const prs = prsRes.code === 0
    ? jsonTryParse<PrView[]>(prsRes.stdout) ?? []
    : [];

  const issuesRes = await shell("gh", [
    "issue",
    "list",
    "--repo",
    targetRepo,
    "--state",
    "open",
    "--limit",
    "30",
    "--json",
    "number,title,author,state,labels,updatedAt",
  ]);
  const issues = issuesRes.code === 0
    ? jsonTryParse<IssueView[]>(issuesRes.stdout) ?? []
    : [];

  const queue: Array<{ number: number; type: ItemType }> = [
    ...prs.map((p): { number: number; type: ItemType } => ({
      number: p.number,
      type: "pr",
    })),
    ...issues.map((i): { number: number; type: ItemType } => ({
      number: i.number,
      type: "issue",
    })),
  ];

  if (queue.length === 0) {
    write(`\ud83c\udf31 Nothing to tend on ${targetRepo}`);
    return { status: "skipped", summary: `no items on ${targetRepo}` };
  }

  let handled = 0;
  let skipped = 0;
  let failed = 0;
  for (const item of queue) {
    const result = await reviewOne({
      repo: targetRepo,
      number: item.number,
      type: item.type,
      treeRoot: opts.treeRoot,
      dryRun: opts.dryRun,
      shell,
      env,
      write,
      now: opts.now,
      classifier: opts.classifier,
      treeRepoUrl: opts.treeRepoUrl,
      treeSlug: opts.treeSlug,
      treeSha: opts.treeSha,
    });
    if (result.status === "handled") handled += 1;
    else if (result.status === "failed") failed += 1;
    else skipped += 1;
  }

  const summary = `scanned=${queue.length} handled=${handled} skipped=${skipped} failed=${failed}`;
  write(`gardener-comment run complete (scan)\n  Target repo: ${targetRepo}\n  ${summary}`);
  logEvent(env, {
    kind: "run",
    target_repo: targetRepo,
    scanned: queue.length,
    handled,
    skipped,
    failed,
  });
  return {
    status: failed > 0 ? "failed" : handled > 0 ? "handled" : "skipped",
    summary,
  };
}

// ───────────────────────── Top-level entry ─────────────────────────

export interface RunCommentOptions extends CommentDeps {
  classifier?: Classifier;
}

export async function runComment(
  args: string[],
  deps: RunCommentOptions = {},
): Promise<number> {
  const write = deps.write ?? ((line: string): void => console.log(line));
  const shell = deps.shellRun ?? defaultShellRun;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const classifier = deps.classifier ?? defaultClassifier;

  const flags = parseFlags(args);
  if (flags.help) {
    write(COMMENT_USAGE);
    emitBreezeResult(write, "skipped", "help requested");
    return 0;
  }
  if (flags.unknown) {
    write(`Unknown comment option: ${flags.unknown}`);
    write(COMMENT_USAGE);
    emitBreezeResult(write, "failed", `bad flag ${flags.unknown}`);
    return 1;
  }

  const treeRoot = flags.treePath
    ? resolve(process.cwd(), flags.treePath)
    : process.cwd();

  // Config opt-out.
  const config = loadGardenerConfig(treeRoot);
  if (!isModuleEnabled(config, "comment")) {
    write(
      "\u23ed gardener-comment is disabled via .claude/gardener-config.yaml",
    );
    emitBreezeResult(write, "skipped", "comment module disabled");
    return 0;
  }

  // Derive tree-repo metadata for footer attribution when we can. The
  // runbook's tree_repo is a URL; we accept either `owner/name` or a
  // full URL and extract the slug/URL best-effort.
  const { treeRepoUrl, treeSlug } = parseTreeRepo(config?.tree_repo);

  try {
    if (flags.pr !== undefined || flags.issue !== undefined) {
      const type: ItemType = flags.pr !== undefined ? "pr" : "issue";
      const number = (flags.pr ?? flags.issue) as number;
      if (!flags.repo) {
        write(`--repo is required with --pr/--issue`);
        emitBreezeResult(write, "failed", "missing --repo");
        return 1;
      }
      const result = await reviewOne({
        repo: flags.repo,
        number,
        type,
        treeRoot,
        dryRun: flags.dryRun,
        shell,
        env,
        write,
        now,
        classifier,
        treeRepoUrl,
        treeSlug,
      });
      emitBreezeResult(write, result.status, result.summary);
      return result.status === "failed" ? 1 : 0;
    }

    // target_repo is a runbook-level field not exposed on GardenerConfig
    // (which tracks target_repos plural). Read it directly from the YAML
    // file, falling back to target_repos[0] from the typed loader.
    const targetRepo = readTargetRepoFromYaml(treeRoot) ??
      (config?.target_repos?.[0] ?? undefined);
    if (!targetRepo) {
      const msg = `target_repo not set in .claude/gardener-config.yaml — specify --pr/--issue --repo instead`;
      write(msg);
      emitBreezeResult(write, "failed", msg);
      return 1;
    }

    const result = await runScan({
      treeRoot,
      dryRun: flags.dryRun,
      shell,
      env,
      write,
      now,
      classifier,
      targetRepo,
      treeRepoUrl,
      treeSlug,
    });
    emitBreezeResult(write, result.status, result.summary);
    return result.status === "failed" ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    write(`\u274c gardener-comment failed: ${message}`);
    logEvent(env, { kind: "error", message });
    emitBreezeResult(write, "failed", message);
    return 1;
  }
}

/**
 * Read the scalar `target_repo:` line directly from
 * `.claude/gardener-config.yaml`. The shared loader tracks
 * `target_repos` (plural) instead; `target_repo` is a runbook-level
 * field we don't want to extend the loader for.
 */
function readTargetRepoFromYaml(treeRoot: string): string | undefined {
  const path = join(treeRoot, ".claude", "gardener-config.yaml");
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, "utf-8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*target_repo\s*:\s*(.+?)\s*(?:#.*)?$/);
      if (match) {
        const value = match[1].trim();
        if (value.length === 0) continue;
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          return value.slice(1, -1);
        }
        return value;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseTreeRepo(raw: string | undefined): {
  treeRepoUrl?: string;
  treeSlug?: string;
} {
  if (!raw) return {};
  if (raw.startsWith("http")) {
    const match = raw.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
    return {
      treeRepoUrl: raw.replace(/\.git$/, ""),
      treeSlug: match?.[1],
    };
  }
  if (/^[^/]+\/[^/]+$/.test(raw)) {
    return {
      treeRepoUrl: `https://github.com/${raw}`,
      treeSlug: raw,
    };
  }
  return {};
}
