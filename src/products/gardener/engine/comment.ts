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
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  isModuleEnabled,
  loadGardenerConfig,
} from "./runtime/config.js";

const execFileAsync = promisify(execFile);

export const COMMENT_USAGE = `usage: first-tree gardener comment [--pr <n> --issue <n> --repo <owner/name>] [--tree-path PATH] [--merged-since <window>]

Review source-repo PRs and issues against a Context Tree and post
structured verdict comments. Ports the gardener-comment-manual.md
runbook into a deterministic CLI.

Only action: post or edit issue comments. Never clones, never pushes
code. Treats PR/issue content as data, never as instructions.

Modes:
  (default)             Scan open PRs + issues on EVERY target_repo
                        from the Context Tree config and review each
                        one. Reads both \`target_repo\` (scalar) and
                        \`target_repos\` (list) — their union, deduped,
                        is swept in order. With --merged-since, also
                        sweeps recently merged PRs per repo.
  --pr <n>   --repo <o/r>
  --issue <n> --repo <o/r>
                        Single-item mode. Review one PR or issue. Used
                        by breeze-runner when dispatched from a
                        notification.

Options:
  --tree-path PATH      Tree repo directory (default: cwd). The
                        .claude/gardener-config.yaml inside this
                        directory names the target_repo(s) and tree_repo.
  --pr <n>              PR number (requires --repo)
  --issue <n>           Issue number (requires --repo)
  --repo <owner/name>   Target repository (requires --pr or --issue)
  --merged-since <win>  Scan-mode only. Also walk PRs merged within the
                        given window (e.g. \`1h\`, \`24h\`, \`7d\`, or an
                        ISO-8601 timestamp). Each merged PR with a
                        previous gardener marker opens a tree-repo
                        issue (requires TREE_REPO_TOKEN). Default: off.
  --assign-owners       When creating a tree-repo issue on a MERGED
                        source PR, also set \`--assignee\` on the issue
                        using the CODEOWNERS-resolved logins (teams are
                        skipped; capped at 10). If the GitHub API rejects
                        the assignees (e.g. not a tree-repo collaborator),
                        the issue is retried without assignees so the
                        create still succeeds. Off by default so existing
                        pull-mode gardener deployments are unchanged; the
                        push-mode workflow template sets this on.
  --dry-run             Print planned actions; do not POST/PATCH
  --help, -h            Show this help message

Environment:
  ANTHROPIC_API_KEY     When set, the CLI wires a built-in Anthropic
                        classifier into runComment. When unset, the CLI
                        refuses to post (it would only produce the
                        INSUFFICIENT_CONTEXT sentinel) and exits with a
                        skip trailer. Required for this command to do
                        anything useful.
  GARDENER_CLASSIFIER_MODEL
                        Override the Claude model used by the built-in
                        classifier (default: claude-haiku-4-5).
  BREEZE_SNAPSHOT_DIR   Directory containing pre-fetched pr-view.json,
                        pr.diff, issue-view.json, issue-comments.json,
                        and subject.json. When set, those files are
                        read instead of invoking \`gh\`.
  COMMENT_LOG           Path for JSONL run events (default
                        $HOME/.gardener/comment-runs.jsonl; falls
                        back to \$TMPDIR when HOME is unset).

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
  options?: {
    cwd?: string;
    input?: string;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  },
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
  options: {
    cwd?: string;
    input?: string;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ShellResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.timeout,
      env: options.env,
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
  assignOwners: boolean;
  /**
   * Lookback window for the scan-mode merged-PR sweep. Accepts a
   * relative duration like `1h`, `24h`, `7d`, or an ISO-8601 timestamp.
   * Undefined means the merged sweep is disabled (default).
   */
  mergedSince?: string;
  unknown?: string;
}

function parseFlags(args: string[]): ParsedFlags {
  const out: ParsedFlags = { help: false, dryRun: false, assignOwners: false };
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
    if (arg === "--assign-owners") {
      out.assignOwners = true;
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
    if (arg === "--merged-since") {
      const value = args[i + 1];
      if (typeof value !== "string" || value.length === 0) {
        out.unknown = `--merged-since requires a duration (e.g. 24h) or ISO-8601 timestamp`;
        return out;
      }
      out.mergedSince = value;
      i += 1;
      continue;
    }
    out.unknown = arg;
    return out;
  }
  return out;
}

/**
 * Resolve the scan-mode merged-PR window into an ISO-8601 lower bound.
 * Accepts:
 *   - Relative duration: `<n>h`, `<n>d`, `<n>m` (m = minutes), `<n>w`
 *   - Absolute ISO-8601 timestamp (passed through unchanged)
 *
 * Returns null when the input is unparseable; callers treat that as
 * "merged sweep skipped, log warning."
 */
export function resolveMergedSinceISO(
  raw: string,
  now: Date,
): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Absolute timestamp pass-through. We accept anything Date can parse
  // and that contains a digit-only date prefix to filter out obvious junk.
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const match = trimmed.match(/^(\d+)\s*([mhdw])$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  const ms = unit === "m"
    ? amount * 60 * 1000
    : unit === "h"
      ? amount * 60 * 60 * 1000
      : unit === "d"
        ? amount * 24 * 60 * 60 * 1000
        : amount * 7 * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - ms).toISOString();
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
export const TREE_ISSUE_CREATED_IN_MARKER_RE =
  /tree_issue_created=(https:\/\/github\.com\/[^\s·>]+)/;
// Lives on its own `<!-- gardener:quiet_refresh_cid=<id> -->` line, not
// inside gardener:state. Self-embeds the comment's own ID so rescans can
// fast-path past quiet-refresh updates (#178, repo-gardener#24).
export const QUIET_REFRESH_CID_MARKER_RE =
  /<!--\s*gardener:quiet_refresh_cid=([^\s]*?)\s*-->/;
export const QUIET_REFRESH_CID_PLACEHOLDER = "self";

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
  treeIssueCreated?: string;
  quietRefreshCid?: string;
} | null {
  const marker = extractStateMarker(body);
  if (!marker) return null;
  const out: {
    reviewed?: string;
    verdict?: Verdict;
    severity?: Severity;
    treeSha?: string;
    treeIssueCreated?: string;
    quietRefreshCid?: string;
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
  const treeIssue = marker.match(TREE_ISSUE_CREATED_IN_MARKER_RE);
  if (treeIssue) out.treeIssueCreated = treeIssue[1];
  // quiet_refresh_cid lives on a separate HTML comment line — scan the
  // full body, not just the state marker. Empty or placeholder values
  // parse as undefined so callers can treat them as "not yet patched."
  const cidMatch = (body ?? "").match(QUIET_REFRESH_CID_MARKER_RE);
  if (cidMatch) {
    const raw = cidMatch[1];
    if (raw.length > 0 && raw !== QUIET_REFRESH_CID_PLACEHOLDER) {
      out.quietRefreshCid = raw;
    }
  }
  return out;
}

/**
 * Rewrite the quiet_refresh_cid marker's value — used after POST to
 * replace the placeholder with the real comment ID. Idempotent: running
 * on a body that already has `cid=<realId>` overwrites with the same
 * value (a retry on an already-patched comment is a no-op diff).
 *
 * Returns null if `body` has no quiet_refresh_cid marker line — caller
 * logs and skips rather than rewriting arbitrary comment bodies.
 */
export function withQuietRefreshCid(
  body: string,
  commentId: string | number,
): string | null {
  if (!QUIET_REFRESH_CID_MARKER_RE.test(body)) return null;
  return body.replace(
    QUIET_REFRESH_CID_MARKER_RE,
    `<!-- gardener:quiet_refresh_cid=${String(commentId)} -->`,
  );
}

export function hasIgnoredMarker(body: string | undefined): boolean {
  if (!body) return false;
  return GARDENER_IGNORED_MARKER_RE.test(body);
}

/**
 * Append `tree_issue_created=<url>` to an existing gardener:state
 * marker. If the marker already has the field, the existing value is
 * replaced (idempotent under duplicate dispatch: a retry after a
 * successful issue create but failed marker PATCH sees the same URL
 * and overwrites with the same URL).
 *
 * Returns null if `body` has no gardener:state marker — caller must
 * decide how to recover (probably log & skip, not rewrite arbitrary
 * comment bodies).
 */
export function withTreeIssueCreatedField(
  body: string,
  issueUrl: string,
): string | null {
  const marker = extractStateMarker(body);
  if (!marker) return null;
  const hasField = TREE_ISSUE_CREATED_IN_MARKER_RE.test(marker);
  const newMarker = hasField
    ? marker.replace(
        TREE_ISSUE_CREATED_IN_MARKER_RE,
        `tree_issue_created=${issueUrl}`,
      )
    : marker.replace(/\s*-->\s*$/, ` · tree_issue_created=${issueUrl} -->`);
  return body.replace(marker, newMarker);
}

/**
 * Parse a CODEOWNERS file and return the @-mentions that own the
 * longest-prefix match of `path`. Matches GitHub's behavior: rules
 * are evaluated top-to-bottom and the **last matching** rule wins.
 *
 * `path` is the tree-relative path the gardener verdict targets
 * (e.g. `pkg-a/foo.ts` or `pkg-a/`). Directories must end with `/`.
 * Returns @-prefixed logins ready to embed in an issue body.
 *
 * Pure string function — caller reads CODEOWNERS themselves (we don't
 * do I/O here so this stays testable without fixtures).
 */
export function codeownersForPath(
  codeownersText: string,
  path: string,
): string[] {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  let winners: string[] = [];
  for (const rawLine of codeownersText.split("\n")) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const pattern = parts[0];
    const owners = parts.slice(1);
    if (codeownersMatches(pattern, normalized)) winners = owners;
  }
  return winners
    .map((o) => o.replace(/^@+/, ""))
    .filter((o) => o.length > 0)
    .map((o) => `@${o}`);
}

/**
 * Minimal CODEOWNERS pattern matcher. Supports the subset
 * `tree generate-codeowners` actually emits:
 *   - `/dir/` — matches everything under /dir/
 *   - `/file.ext` — exact file match
 *   - `*` — root fallback (every path matches)
 * Extra glob features (`**`, `*.ext`) are not emitted by our generator,
 * so we don't try to replicate GitHub's full semantics.
 */
function codeownersMatches(pattern: string, path: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  return path === pattern;
}

/**
 * Build a tree-repo issue body describing a gardener verdict on a
 * merged source PR. Consumed by Phase 2b's MERGED-scan branch. Kept
 * separate from `buildCommentBody` (source-PR audience) because the
 * tree-repo audience — node owners looking at an unassigned issue in
 * their own repo — needs different framing: *what source change
 * happened, which tree nodes might be affected, and why gardener
 * flagged it*.
 */
export interface BuildTreeIssueBodyInput {
  /** Source repo slug e.g. "alice/cool-thing". */
  sourceRepo: string;
  /** Source PR number. */
  sourcePr: number;
  /** Source PR title (for human context). */
  sourcePrTitle: string;
  /** URL to the source-PR gardener-state comment (for traceability). */
  sourceCommentUrl: string;
  verdict: Verdict;
  severity: Severity;
  /** One-line summary of the change — from the verdict. */
  summary: string;
  /** Tree nodes gardener cited. */
  treeNodes: { path: string; summary: string }[];
  /** @-prefixed logins to cc (from CODEOWNERS resolution). May be empty. */
  codeownersMentions: string[];
  /**
   * When true, reflect in the body text that gardener attempted to set
   * assignees on the issue (push/workflow-mode). When false, the body
   * keeps the original "not auto-assigned — pick it up via CODEOWNERS
   * routing" phrasing used by pull-mode deployments. Purely cosmetic:
   * it does not trigger the actual `--assignee` call, which lives in
   * `handleMergedIssue`.
   */
  autoAssigned?: boolean;
}

export function buildTreeIssueBody(input: BuildTreeIssueBodyInput): string {
  const {
    sourceRepo,
    sourcePr,
    sourcePrTitle,
    sourceCommentUrl,
    verdict,
    severity,
    summary,
    treeNodes,
    codeownersMentions,
    autoAssigned = false,
  } = input;
  const emoji = VERDICT_EMOJI[verdict];
  const nodeList =
    treeNodes.length > 0
      ? treeNodes.map((n) => `- \`${n.path}\` — ${n.summary}`).join("\n")
      : "- _(no tree nodes cited)_";
  const ccLine =
    codeownersMentions.length > 0
      ? `cc ${codeownersMentions.join(" ")}`
      : "_(no CODEOWNERS match for cited nodes — issue is unassigned)_";
  const actionLine = autoAssigned && codeownersMentions.length > 0
    ? `A node owner should decide whether the tree needs an update in response to this merged change. This issue is auto-filed by gardener and auto-assigned to the node owners cited above (teams skipped; logins the tree repo rejects fall through to the cc line).`
    : `A node owner should decide whether the tree needs an update in response to this merged change. This issue is auto-filed by gardener and not auto-assigned — pick it up via CODEOWNERS routing.`;
  return [
    `## Merged source change needs tree review`,
    "",
    `${emoji} **verdict:** \`${verdict}\` · **severity:** \`${severity}\``,
    "",
    `**Source PR:** [${sourceRepo}#${sourcePr}](https://github.com/${sourceRepo}/pull/${sourcePr}) — ${sourcePrTitle}`,
    `**Gardener verdict:** ${sourceCommentUrl}`,
    "",
    `### What changed`,
    "",
    summary,
    "",
    `### Tree nodes potentially affected`,
    "",
    nodeList,
    "",
    `### Action`,
    "",
    actionLine,
    "",
    ccLine,
    "",
    "---",
    "",
    `<sub>🌱 Auto-filed by [repo-gardener](https://github.com/agent-team-foundation/repo-gardener) via [First-Tree](https://github.com/agent-team-foundation/first-tree). Close this issue when the tree reflects the source change (or when no change is warranted).</sub>`,
  ].join("\n");
}

/**
 * Turn `@alice`, `@team/frontend` mentions into a bare-login assignee
 * list for `gh issue create --assignee`:
 *   - strip the leading `@`
 *   - drop team mentions (contain `/`); GitHub rejects them for issues
 *   - dedupe
 *   - cap at 10 (GitHub's per-issue assignee ceiling)
 */
export function assigneesFromMentions(mentions: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of mentions) {
    const stripped = raw.replace(/^@+/, "").trim();
    if (!stripped) continue;
    if (stripped.includes("/")) continue;
    if (seen.has(stripped)) continue;
    seen.add(stripped);
    out.push(stripped);
    if (out.length >= 10) break;
  }
  return out;
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
  //
  // Semantics: the presence of a `gardener:paused` marker on gardener's own
  // comment IS the paused state. gardener only writes that marker in
  // response to a valid `@gardener pause` command, so the marker itself is
  // the authoritative record. Do NOT require the `@gardener pause` comment
  // to still exist — a user may have edited or deleted it.
  //
  // Only a `@gardener resume` command newer than the marker clears the state.
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

  const latestPausedMarkerTime = gardenerComments
    .filter((c) => hasPausedMarker(c.body))
    .reduce<string | null>((latest, c) => {
      const ts = c.created_at ?? null;
      if (!ts) return latest;
      if (!latest || ts > latest) return ts;
      return latest;
    }, null);

  if (latestPausedMarkerTime) {
    const lastResume = latestByCmd("resume");
    if (!lastResume || lastResume <= latestPausedMarkerTime) {
      return { kind: "skip", reason: "paused by user" };
    }
    // else fall through to rule 4 — resume is newer than paused marker.
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
 * match" guidance). This default returns `INSUFFICIENT_CONTEXT` with
 * low severity — semantically honest, since no LLM has been consulted.
 * Previously this returned `NEW_TERRITORY/low`, which misrepresented
 * "no judgment made" as "judged this is a new area" and would send a
 * misleading signal if ever posted to a real PR. Callers must inject
 * a real classifier to get meaningful verdicts.
 */
export type Classifier = (input: ClassifyInput) => Promise<ClassifyOutput>;

export const defaultClassifier: Classifier = async () => ({
  verdict: "INSUFFICIENT_CONTEXT",
  severity: "low",
  summary:
    "No classifier was injected; gardener cannot judge this PR without one.",
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
  // If treeRepoUrl is missing (no tree_repo in config, or unparseable), render
  // tree node paths as plain inline code — DO NOT produce `[`path`](/blob/main/path)`
  // which GitHub resolves relative to the current repo and 404s.
  const renderNode = (n: { path: string; summary: string }): string =>
    treeRepoUrl
      ? `- [\`${n.path}\`](${treeRepoUrl}/blob/main/${n.path}) — ${n.summary}`
      : `- \`${n.path}\` — ${n.summary}`;
  const treeNodeLinks =
    treeNodes.length > 0
      ? treeNodes.map(renderNode).join("\n")
      : `- _(no tree nodes cited — tree may be empty or irrelevant to this change)_`;
  const markerLine1 = `<!-- gardener:state · reviewed=${reviewedFull} · verdict=${verdict} · severity=${severity} · tree_sha=${treeSha} -->`;
  const markerLine2 = `<!-- gardener:last_consumed_rereview=${consumedId} -->`;
  // Placeholder on first POST; comment.ts issues a follow-up PATCH to
  // replace `<self>` with the newly-created comment's own ID. Old
  // comments without this line continue to parse as cid=undefined.
  const markerLine3 = `<!-- gardener:quiet_refresh_cid=${QUIET_REFRESH_CID_PLACEHOLDER} -->`;

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
    markerLine3,
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

export function commentLogPath(env: NodeJS.ProcessEnv): string {
  if (env.COMMENT_LOG && env.COMMENT_LOG.length > 0) return env.COMMENT_LOG;
  const home = env.HOME ?? env.USERPROFILE ?? tmpdir();
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
  extras?: Record<string, string>,
): void {
  const compact = summary.replace(/\s+/g, " ").trim() || "no-op";
  const extraPairs = extras
    ? Object.entries(extras)
        .map(([k, v]) => ` ${k}=${v.replace(/\s+/g, "_")}`)
        .join("")
    : "";
  write(`BREEZE_RESULT: status=${status} summary=${compact}${extraPairs}`);
}

// ───────────────────────── MERGED → tree-repo issue ────────────────

export interface HandleMergedIssueInput {
  sourceRepo: string;
  sourcePr: number;
  sourcePrTitle: string;
  /** The existing gardener-state comment on the source PR. */
  gardenerCommentId: number;
  gardenerCommentBody: string;
  /** Tree repo slug `owner/name`. */
  treeSlug: string;
  /** Classifier output from the merged SHA (verdict + severity + nodes). */
  verdict: Verdict;
  severity: Severity;
  summary: string;
  treeNodes: { path: string; summary: string }[];
  /** Resolved CODEOWNERS cc list, already @-prefixed. */
  codeownersMentions: string[];
  /**
   * When true, add `--assignee` to the `gh issue create` call using
   * `assigneesFromMentions(codeownersMentions)`. On rejection (422 or
   * "assignee"/"collaborator" stderr), retry without `--assignee` so
   * the issue still opens. Default false preserves current pull-mode
   * behavior (cc-in-body only).
   */
  assignOwners: boolean;
  shell: ShellRun;
  env: NodeJS.ProcessEnv;
  write: (line: string) => void;
  dryRun: boolean;
}

export type HandleMergedIssueOutcome =
  | { kind: "created"; issueUrl: string; markerPatched: boolean }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string; issueUrl?: string };

/**
 * Creates a tree-repo issue for a merged source PR and PATCHes the
 * source-PR gardener comment to mark the link. Called exactly once
 * per merged source PR per scan from `reviewOne`.
 *
 * Contract (spec: #166, signed off on 2026-04-17):
 *   - `TREE_REPO_TOKEN` is required on both tree-repo calls. No fallback
 *     to ambient `gh` auth — unset → `skipped`.
 *   - Marker is the sole source of truth for idempotency; caller must
 *     already have checked `tree_issue_created` is absent from the
 *     existing marker before invoking this function.
 *   - No in-process retry. 401/403/404 on tree-repo calls → `skipped`
 *     (treat as config error). 5xx/network → `failed`.
 *   - On issue-create success + marker-PATCH failure, returns
 *     `failed` but with `issueUrl` set so the caller logs it for
 *     manual recovery.
 */
export async function handleMergedIssue(
  input: HandleMergedIssueInput,
): Promise<HandleMergedIssueOutcome> {
  const {
    sourceRepo,
    sourcePr,
    sourcePrTitle,
    gardenerCommentId,
    gardenerCommentBody,
    treeSlug,
    verdict,
    severity,
    summary,
    treeNodes,
    codeownersMentions,
    assignOwners,
    shell,
    env,
    write,
    dryRun,
  } = input;

  const treeRepoToken = env.TREE_REPO_TOKEN;
  if (!treeRepoToken) {
    return { kind: "skipped", reason: "TREE_REPO_TOKEN unset" };
  }

  const sourceCommentUrl =
    `https://github.com/${sourceRepo}/pull/${sourcePr}#issuecomment-${gardenerCommentId}`;

  const assignees = assignOwners
    ? assigneesFromMentions(codeownersMentions)
    : [];
  const body = buildTreeIssueBody({
    sourceRepo,
    sourcePr,
    sourcePrTitle,
    sourceCommentUrl,
    verdict,
    severity,
    summary,
    treeNodes,
    codeownersMentions,
    autoAssigned: assignOwners,
  });
  const title = `[gardener] tree update needed for ${sourceRepo}#${sourcePr}`;

  write(
    `\u2712 merged ${sourceRepo}#${sourcePr}: creating tree issue on ${treeSlug}${
      assignees.length > 0 ? ` (assignees: ${assignees.join(", ")})` : ""
    }`,
  );

  if (dryRun) {
    return { kind: "created", issueUrl: "(dry-run)", markerPatched: true };
  }

  const tokenEnv: NodeJS.ProcessEnv = { ...env, GH_TOKEN: treeRepoToken };

  const baseCreateArgs = [
    "issue",
    "create",
    "--repo",
    treeSlug,
    "--title",
    title,
    "--body",
    body,
  ];
  const firstArgs = assignees.length > 0
    ? [...baseCreateArgs, "--assignee", assignees.join(",")]
    : baseCreateArgs;

  let createRes = await shell("gh", firstArgs, { env: tokenEnv });
  if (createRes.code !== 0 && assignees.length > 0) {
    // GitHub rejects `--assignee` when any login isn't a tree-repo
    // collaborator (422). Retry without assignees so the issue still
    // opens; the cc line in the body preserves owner visibility.
    const stderr = createRes.stderr || "";
    const assigneeBad = /assignee|collaborator|422|unprocessable/i.test(stderr);
    if (assigneeBad) {
      write(
        `\u26a0 tree-issue assignment rejected (${stderr.split("\n")[0] || "422"}) — retrying without --assignee`,
      );
      createRes = await shell("gh", baseCreateArgs, { env: tokenEnv });
    }
  }
  if (createRes.code !== 0) {
    const stderr = createRes.stderr || "";
    const isConfigError = /\b(401|403|404)\b/.test(stderr);
    const reason = isConfigError
      ? `tree-repo auth/access error (${stderr.split("\n")[0] || "401/403/404"})`
      : `gh issue create failed: ${stderr.split("\n")[0] || "unknown"}`;
    return isConfigError
      ? { kind: "skipped", reason }
      : { kind: "failed", reason };
  }
  const issueUrl = createRes.stdout.trim().split("\n").pop()?.trim() ?? "";

  const newBody = withTreeIssueCreatedField(gardenerCommentBody, issueUrl);
  if (!newBody) {
    return {
      kind: "failed",
      reason: "marker not found on gardener comment — cannot PATCH",
      issueUrl,
    };
  }

  const patchRes = await shell(
    "gh",
    [
      "api",
      "-X",
      "PATCH",
      `/repos/${sourceRepo}/issues/comments/${gardenerCommentId}`,
      "-f",
      `body=${newBody}`,
    ],
    { env: tokenEnv },
  );
  if (patchRes.code !== 0) {
    write(
      `\u26A0 tree issue created at ${issueUrl} but marker PATCH failed — ` +
        `record manually: ${patchRes.stderr.split("\n")[0] || "unknown error"}`,
    );
    return { kind: "failed", reason: "marker PATCH failed", issueUrl };
  }

  return { kind: "created", issueUrl, markerPatched: true };
}

/**
 * Decide whether a MERGED source PR requires a tree-repo issue, and
 * if so, run the create + marker-PATCH dance via `handleMergedIssue`.
 *
 * Returns:
 *   - `null`  — fall through to the existing stale-skip (no gardener
 *               marker, or marker already has `tree_issue_created`).
 *   - a `{ status, summary }` shape when the merged branch took
 *               responsibility for this PR (handled | skipped | failed).
 */
async function tryHandleMergedPr(input: {
  sourceRepo: string;
  sourcePr: number;
  sourcePrTitle: string;
  sourcePrDiff?: string;
  sourcePrView?: PrView;
  comments: IssueComment[];
  gardenerUser: string;
  treeRoot: string;
  treeSlug?: string;
  treeSha?: string;
  classifier: Classifier;
  shell: ShellRun;
  env: NodeJS.ProcessEnv;
  write: (line: string) => void;
  dryRun: boolean;
  assignOwners: boolean;
}): Promise<{ status: CommentStatus; summary: string } | null> {
  const {
    sourceRepo,
    sourcePr,
    sourcePrTitle,
    sourcePrDiff,
    sourcePrView,
    comments,
    gardenerUser,
    treeRoot,
    treeSlug,
    treeSha,
    classifier,
    shell,
    env,
    write,
    dryRun,
    assignOwners,
  } = input;

  const hasGardenerMarker = (b: string | undefined): boolean =>
    typeof b === "string" && /<!--\s*gardener:/.test(b);
  const gardenerComments = comments.filter(
    (c) =>
      (c.user?.login === gardenerUser || hasGardenerMarker(c.body)) &&
      c.body && c.body.length > 0,
  );
  const latestState = gardenerComments
    .filter((c) => extractStateMarker(c.body) !== null)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
    .pop();

  if (!latestState || latestState.id === undefined) return null;
  const parsed = parseStateMarker(latestState.body);
  if (!parsed) return null;
  if (parsed.treeIssueCreated) {
    // Already linked — idempotent skip, but count it as handled so the
    // trailer reflects that this PR was considered by the branch.
    return {
      status: "skipped",
      summary: `merged #${sourcePr}: already linked to ${parsed.treeIssueCreated}`,
    };
  }

  if (!treeSlug) {
    return {
      status: "skipped",
      summary: `merged #${sourcePr}: tree_repo not configured`,
    };
  }

  // Token gate — load-bearing. No fallback to ambient gh auth.
  const treeRepoToken = env.TREE_REPO_TOKEN;
  if (!treeRepoToken) {
    return {
      status: "skipped",
      summary: `merged #${sourcePr}: TREE_REPO_TOKEN unset`,
    };
  }

  const classification = await classifier({
    type: "pr",
    prView: sourcePrView,
    diff: sourcePrDiff,
    treeRoot,
    treeSha,
  });

  const codeownersPath = join(treeRoot, ".github", "CODEOWNERS");
  const codeownersText = existsSync(codeownersPath)
    ? readFileSync(codeownersPath, "utf-8")
    : "";
  const mentions = new Set<string>();
  for (const node of classification.treeNodes) {
    for (const m of codeownersForPath(codeownersText, node.path)) {
      mentions.add(m);
    }
  }

  const outcome = await handleMergedIssue({
    sourceRepo,
    sourcePr,
    sourcePrTitle,
    gardenerCommentId: latestState.id,
    gardenerCommentBody: latestState.body ?? "",
    treeSlug,
    verdict: classification.verdict,
    severity: classification.severity,
    summary: classification.summary,
    treeNodes: classification.treeNodes,
    codeownersMentions: Array.from(mentions),
    assignOwners,
    shell,
    env,
    write,
    dryRun,
  });

  if (outcome.kind === "created") {
    write(
      `\u2713 merged ${sourceRepo}#${sourcePr}: tree issue ${outcome.issueUrl}`,
    );
    return {
      status: "handled",
      summary: `merged #${sourcePr}: opened ${outcome.issueUrl}`,
    };
  }
  if (outcome.kind === "skipped") {
    write(`\u23ed merged ${sourceRepo}#${sourcePr}: ${outcome.reason}`);
    return {
      status: "skipped",
      summary: `merged #${sourcePr}: ${outcome.reason}`,
    };
  }
  const tail = outcome.issueUrl ? ` (issue: ${outcome.issueUrl})` : "";
  write(`\u274c merged ${sourceRepo}#${sourcePr}: ${outcome.reason}${tail}`);
  return {
    status: "failed",
    summary: `merged #${sourcePr}: ${outcome.reason}${tail}`,
  };
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
  assignOwners: boolean;
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
    assignOwners,
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

  // Freshness guard — handle merged/closed items.
  //
  // MERGED-PR branch (Phase 2b, #162/#166): if the source PR was
  // merged with a `gardener:state` marker that has not yet been
  // linked to a tree-repo issue, create the tree issue (gated on
  // `TREE_REPO_TOKEN`) and PATCH the marker. Other MERGED paths —
  // no marker, or marker already linked — fall through to the
  // existing stale skip.
  const itemState = type === "pr"
    ? bundle.prView?.state
    : bundle.issueView?.state;
  if (type === "pr" && itemState === "MERGED") {
    const mergedOutcome = await tryHandleMergedPr({
      sourceRepo: repo,
      sourcePr: number,
      sourcePrTitle: bundle.prView?.title ?? `#${number}`,
      sourcePrDiff: bundle.diff,
      sourcePrView: bundle.prView,
      comments: bundle.issueComments,
      gardenerUser,
      treeRoot,
      treeSlug: opts.treeSlug,
      treeSha: opts.treeSha ?? bundle.subject.treeSha,
      classifier,
      shell,
      env,
      write,
      dryRun,
      assignOwners,
    });
    if (mergedOutcome) {
      logEvent(env, {
        kind: "merged_issue",
        number,
        status: mergedOutcome.status,
        summary: mergedOutcome.summary,
      });
      return mergedOutcome;
    }
    // Otherwise fall through to stale skip.
  }
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
    // PATCH existing comment (Step 4e). On the same PATCH, fill the
    // quiet_refresh_cid placeholder with this comment's own ID so
    // re-reviews keep the cid in sync (covers legacy comments that
    // never had the cid patched in on first POST).
    write(
      `\u2712 #${number}: re-review → PATCH comment ${action.commentId} (${classification.verdict})`,
    );
    const patchedBody = withQuietRefreshCid(body, action.commentId) ?? body;
    if (!dryRun) {
      await shell("gh", [
        "api",
        "-X",
        "PATCH",
        `/repos/${repo}/issues/comments/${action.commentId}`,
        "-f",
        `body=${patchedBody}`,
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

  // First review — POST new comment, then PATCH to self-embed the
  // comment's own ID into the quiet_refresh_cid placeholder. Two-step
  // sequence matches the repo-gardener runbook (#178): POST returns
  // the new ID, PATCH rewrites `<self>` to the real value so rescans
  // can fast-path past gardener's own quiet-refresh updates.
  write(
    `\u2713 #${number}: first review → POST (${classification.verdict}/${classification.severity})`,
  );
  if (!dryRun) {
    const postRes = await shell("gh", [
      "api",
      "-X",
      "POST",
      `/repos/${repo}/issues/${number}/comments`,
      "-f",
      `body=${body}`,
    ]);
    if (postRes.code === 0) {
      const parsed = jsonTryParse<{ id?: number | string }>(postRes.stdout);
      const newId = parsed?.id;
      if (newId !== undefined && newId !== null) {
        const patchedBody = withQuietRefreshCid(body, newId);
        if (patchedBody !== null && patchedBody !== body) {
          await shell("gh", [
            "api",
            "-X",
            "PATCH",
            `/repos/${repo}/issues/comments/${newId}`,
            "-f",
            `body=${patchedBody}`,
          ]);
        }
      }
    }
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
  assignOwners: boolean;
  /** ISO-8601 lower bound for merged PR sweep; undefined disables. */
  mergedSinceISO?: string;
}): Promise<{ status: CommentStatus; summary: string }> {
  const { shell, write, env, targetRepo, mergedSinceISO } = opts;

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

  // Merged-PR sweep — opt-in via --merged-since. Each merged PR with a
  // prior gardener marker is routed through reviewOne, which fires the
  // tree-issue creation branch when TREE_REPO_TOKEN is present.
  let mergedPrs: PrView[] = [];
  if (mergedSinceISO) {
    const mergedRes = await shell("gh", [
      "pr",
      "list",
      "--repo",
      targetRepo,
      "--state",
      "merged",
      "--search",
      `merged:>=${mergedSinceISO}`,
      "--limit",
      "50",
      "--json",
      "number,title,headRefName,headRefOid,state,author,additions,deletions,labels,updatedAt",
    ]);
    mergedPrs = mergedRes.code === 0
      ? jsonTryParse<PrView[]>(mergedRes.stdout) ?? []
      : [];
  }

  // Dedup: an item could appear in both open and merged lists if state
  // changed mid-scan. Open wins because it carries fresher head data.
  const seen = new Set<string>();
  const queue: Array<{ number: number; type: ItemType }> = [];
  for (const p of prs) {
    const key = `pr:${p.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push({ number: p.number, type: "pr" });
  }
  for (const i of issues) {
    const key = `issue:${i.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push({ number: i.number, type: "issue" });
  }
  for (const p of mergedPrs) {
    const key = `pr:${p.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push({ number: p.number, type: "pr" });
  }

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
      assignOwners: opts.assignOwners,
    });
    if (result.status === "handled") handled += 1;
    else if (result.status === "failed") failed += 1;
    else skipped += 1;
  }

  const mergedTag = mergedSinceISO ? ` merged_since=${mergedSinceISO}` : "";
  const summary = `scanned=${queue.length} handled=${handled} skipped=${skipped} failed=${failed}${mergedTag}`;
  write(`gardener-comment run complete (scan)\n  Target repo: ${targetRepo}\n  ${summary}`);
  logEvent(env, {
    kind: "run",
    target_repo: targetRepo,
    scanned: queue.length,
    handled,
    skipped,
    failed,
    merged_since: mergedSinceISO ?? null,
  });
  return {
    status: failed > 0 ? "failed" : handled > 0 ? "handled" : "skipped",
    summary,
  };
}

/**
 * Read the `target_repos:` list from `.claude/gardener-config.yaml`.
 * Lighter than the full typed loader — just enough to enumerate the
 * repos for scan-mode dispatch. Returns an empty array when the key is
 * missing or unreadable.
 */
function readTargetReposFromYaml(treeRoot: string): string[] {
  const path = join(treeRoot, ".claude", "gardener-config.yaml");
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  let listIndent = -1;
  for (const raw of lines) {
    const stripped = raw.replace(/#.*$/, "").trimEnd();
    if (stripped.trim() === "") continue;
    const indent = stripped.match(/^\s*/)?.[0].length ?? 0;
    if (!inList) {
      if (/^\s*target_repos\s*:\s*$/.test(stripped)) {
        inList = true;
        listIndent = indent;
        continue;
      }
      // Inline form: target_repos: [a, b]
      const inline = stripped.match(/^\s*target_repos\s*:\s*\[(.+)\]\s*$/);
      if (inline) {
        for (const part of inline[1].split(",")) {
          const v = part.trim().replace(/^['"]|['"]$/g, "");
          if (v.length > 0) out.push(v);
        }
        return out;
      }
      continue;
    }
    // Inside list block
    if (indent <= listIndent) break;
    const itemMatch = stripped.match(/^\s*-\s*(.+?)\s*$/);
    if (!itemMatch) break;
    const value = itemMatch[1].replace(/^['"]|['"]$/g, "");
    if (value.length > 0) out.push(value);
  }
  return out;
}

/**
 * Compute the deduped, in-order list of target repos for scan mode.
 * Sources, in priority: (1) scalar `target_repo` from YAML, (2) list
 * `target_repos` from YAML / typed loader. Order is preserved per
 * source; duplicates across sources are dropped.
 */
export function collectTargetRepos(
  treeRoot: string,
  config: { target_repos?: string[] } | null,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (slug: string | undefined): void => {
    if (!slug) return;
    const trimmed = slug.trim();
    if (trimmed.length === 0) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  add(readTargetRepoFromYaml(treeRoot));
  for (const slug of readTargetReposFromYaml(treeRoot)) add(slug);
  for (const slug of config?.target_repos ?? []) add(slug);
  return out;
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

  // No injected classifier → the stock CLI path. The default classifier
  // cannot produce a real verdict, only the INSUFFICIENT_CONTEXT sentinel,
  // so running the full review pipeline would just post spam. Bail out
  // early with a clear message. Callers that embed runComment must inject
  // a real classifier to opt in to posting.
  if (!deps.classifier) {
    const msg =
      "gardener-comment: no classifier injected — refusing to post. " +
      "The stock CLI does not ship a judgment engine; embed runComment with " +
      "a classifier (see RunCommentOptions) or wait for a release that bundles one.";
    write(msg);
    emitBreezeResult(write, "skipped", "no classifier injected");
    return 0;
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
        assignOwners: flags.assignOwners,
      });
      emitBreezeResult(write, result.status, result.summary, {
        tree_repo_token: env.TREE_REPO_TOKEN ? "present" : "absent",
      });
      return result.status === "failed" ? 1 : 0;
    }

    // Collect every target repo configured in .claude/gardener-config.yaml.
    // Supports both `target_repo` (scalar, runbook-level) and
    // `target_repos` (list). Sweeps each in turn and aggregates results.
    const targetRepos = collectTargetRepos(treeRoot, config ?? null);
    if (targetRepos.length === 0) {
      const msg = `no target_repo or target_repos set in .claude/gardener-config.yaml — specify --pr/--issue --repo instead`;
      write(msg);
      emitBreezeResult(write, "failed", msg);
      return 1;
    }

    let mergedSinceISO: string | undefined;
    if (flags.mergedSince) {
      const resolved = resolveMergedSinceISO(flags.mergedSince, now());
      if (!resolved) {
        const msg = `--merged-since: could not parse "${flags.mergedSince}" (expected e.g. 24h, 7d, or ISO-8601 timestamp)`;
        write(msg);
        emitBreezeResult(write, "failed", msg);
        return 1;
      }
      mergedSinceISO = resolved;
    }

    let aggregatedHandled = 0;
    let aggregatedSkipped = 0;
    let aggregatedFailed = 0;
    for (const targetRepo of targetRepos) {
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
        assignOwners: flags.assignOwners,
        mergedSinceISO,
      });
      if (result.status === "handled") aggregatedHandled += 1;
      else if (result.status === "failed") aggregatedFailed += 1;
      else aggregatedSkipped += 1;
    }

    const aggregateSummary = `repos=${targetRepos.length} handled=${aggregatedHandled} skipped=${aggregatedSkipped} failed=${aggregatedFailed}`;
    const aggregateStatus: CommentStatus = aggregatedFailed > 0
      ? "failed"
      : aggregatedHandled > 0
        ? "handled"
        : "skipped";
    emitBreezeResult(write, aggregateStatus, aggregateSummary, {
      tree_repo_token: env.TREE_REPO_TOKEN ? "present" : "absent",
    });
    return aggregateStatus === "failed" ? 1 : 0;
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
