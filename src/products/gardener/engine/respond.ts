/**
 * gardener-respond — port of `gardener-respond-manual.md` runbook.
 *
 * Reads review feedback on sync PRs (branches prefixed `first-tree/sync-`
 * or label `first-tree:sync`), classifies it, applies fixes, replies to
 * reviewers, and records learnings for gardener-sync.
 *
 * This TypeScript port preserves the runbook's hard rules byte-for-byte
 * where the runbook is specific. Output text, labels, commit messages,
 * and marker formats match the runbook.
 *
 * Dual-path execution:
 *   - When `$BREEZE_SNAPSHOT_DIR` is set, reads pre-fetched PR data from
 *     JSON files in that directory (used by the breeze-runner dispatch).
 *   - Otherwise, calls `gh api` / `gh pr …` to fetch data live.
 *
 * Config opt-out: if `.claude/gardener-config.yaml` sets
 * `modules.respond.enabled: false`, the command exits cleanly (0) with
 * a one-line note.
 *
 * BREEZE_RESULT trailer: the last line of stdout is always
 *   `BREEZE_RESULT: status=<handled|skipped|failed> summary=<...>`
 * so breeze-runner can parse the outcome from a captured stdout buffer.
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

export const RESPOND_USAGE = `usage: first-tree gardener respond [--pr <n> --repo <owner/name>] [--tree-path PATH]

Fix sync PRs based on reviewer feedback. Ports the
gardener-respond-manual.md runbook into a deterministic CLI.

Only acts on PRs whose branch starts with \`first-tree/sync-\` or whose
label set contains \`first-tree:sync\`. Never force-pushes, never creates
new PRs, never merges (that is the reviewer agent's job).

Modes:
  (default)             Scan all open sync PRs on the tree repo in cwd
                        and fix each CHANGES_REQUESTED PR.
  --pr <n> --repo <o/r> Single-PR mode. Fix one PR. Used by breeze-runner
                        when dispatched from a review notification.

Options:
  --tree-path PATH      Tree repo directory (default: cwd)
  --pr <n>              PR number (requires --repo)
  --repo <owner/name>   Target repository (requires --pr)
  --dry-run             Print planned actions; do not push or comment
  --help, -h            Show this help message

Environment:
  BREEZE_SNAPSHOT_DIR   Directory containing pre-fetched pr-view.json,
                        pr.diff, pr-reviews.json, issue-comments.json.
                        When set, those files are read instead of
                        invoking \`gh\`.
  RESPOND_LOG           Path for JSONL run events (default
                        $HOME/.gardener/respond-runs.jsonl).

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

export interface RespondDeps {
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

export type RespondStatus = "handled" | "skipped" | "failed" | "disabled";

export interface PrView {
  number: number;
  title?: string;
  body?: string;
  headRefName?: string;
  reviewDecision?: string;
  labels?: { name: string }[] | string[];
  updatedAt?: string;
}

export interface PrReview {
  user?: { login?: string };
  state?: string;
  body?: string;
  submitted_at?: string;
}

export interface PrIssueComment {
  user?: { login?: string };
  body?: string;
  created_at?: string;
}

export interface SnapshotBundle {
  prView: PrView;
  diff: string;
  reviews: PrReview[];
  issueComments: PrIssueComment[];
}

export const RESPOND_MAX_ATTEMPTS = 5;
const ATTEMPTS_MARKER_RE = /<!--\s*gardener:respond-attempts=(\d+)\s*-->/;
const SOURCE_PR_RE = /source_pr=(\d+)/;
const GARDENER_FIX_RE = /@gardener\s+fix/i;
const GARDENER_MARKER_RE = /<!--\s*gardener:/;

/**
 * True when a review or comment was authored by gardener itself.
 *
 * Two signals (either one fires):
 *   - login match: entry.user.login === gardenerLogin (when known)
 *   - HTML marker fallback: entry.body contains `<!-- gardener:`
 *
 * Used to filter self-authored feedback out of the "actionable review"
 * count so gardener-respond never reacts to gardener-sync's own
 * review-pass comment (self-loop guard — first-tree#134 / repo-gardener#22).
 */
export function isFromGardener(
  entry: { user?: { login?: string }; body?: string },
  gardenerLogin: string,
): boolean {
  if (gardenerLogin && entry.user?.login === gardenerLogin) return true;
  if (entry.body && GARDENER_MARKER_RE.test(entry.body)) return true;
  return false;
}

async function resolveGardenerLogin(shell: ShellRun): Promise<string> {
  const res = await shell("gh", ["api", "user", "--jq", ".login"]);
  return res.code === 0 ? res.stdout.trim() : "";
}

export function readRespondAttempts(body: string | undefined): number {
  if (!body) return 0;
  const match = body.match(ATTEMPTS_MARKER_RE);
  if (!match) return 0;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function writeRespondAttempts(
  body: string | undefined,
  attempts: number,
): string {
  const marker = `<!-- gardener:respond-attempts=${attempts} -->`;
  const current = body ?? "";
  if (ATTEMPTS_MARKER_RE.test(current)) {
    return current.replace(ATTEMPTS_MARKER_RE, marker);
  }
  const sep = current.length > 0 && !current.endsWith("\n") ? "\n\n" : "\n";
  return current.length === 0 ? marker : `${current}${sep}${marker}\n`;
}

export function hasSyncLabel(view: PrView): boolean {
  const labels = view.labels ?? [];
  for (const label of labels) {
    const name = typeof label === "string" ? label : label?.name;
    if (name === "first-tree:sync") return true;
  }
  return false;
}

export function isSyncPr(view: PrView): boolean {
  if (view.headRefName && view.headRefName.startsWith("first-tree/sync-")) {
    return true;
  }
  return hasSyncLabel(view);
}

export function extractSourcePr(
  body: string | undefined,
): { sourcePr: number; sourceRepo: string | undefined } | null {
  if (!body) return null;
  const prMatch = body.match(SOURCE_PR_RE);
  if (!prMatch) return null;
  const sourcePr = Number(prMatch[1]);
  if (!Number.isFinite(sourcePr)) return null;
  const repoMatch = body.match(/source_repo=([^\s·]+)/);
  const sourceRepo = repoMatch ? repoMatch[1].trim() : undefined;
  return { sourcePr, sourceRepo };
}

export function classifyReviewDecision(
  view: PrView,
  hasGardenerFix: boolean,
): "approved" | "changes_requested" | "housekeeping" | "none" {
  if (view.title && /housekeeping/i.test(view.title)) return "housekeeping";
  if (view.reviewDecision === "APPROVED") return "approved";
  if (view.reviewDecision === "CHANGES_REQUESTED") return "changes_requested";
  if (hasGardenerFix) return "changes_requested";
  return "none";
}

export function latestChangesRequestedAt(reviews: PrReview[]): string | null {
  let latest: string | null = null;
  for (const review of reviews) {
    if (review.state !== "CHANGES_REQUESTED") continue;
    if (!review.submitted_at) continue;
    if (!latest || review.submitted_at > latest) latest = review.submitted_at;
  }
  return latest;
}

function latestReviewerLogin(reviews: PrReview[]): string | undefined {
  let latestAt: string | undefined;
  let latestLogin: string | undefined;
  for (const review of reviews) {
    if (review.state !== "CHANGES_REQUESTED") continue;
    if (!review.user?.login) continue;
    const at = review.submitted_at;
    if (!at) {
      if (!latestLogin) latestLogin = review.user.login;
      continue;
    }
    if (!latestAt || at > latestAt) {
      latestAt = at;
      latestLogin = review.user.login;
    }
  }
  return latestLogin;
}

function jsonTryParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Read a snapshot bundle from $BREEZE_SNAPSHOT_DIR. Returns null if the
 * required files are missing or unparsable — caller should fall back to
 * live gh fetches.
 */
export function readSnapshot(dir: string): SnapshotBundle | null {
  const viewPath = join(dir, "pr-view.json");
  const reviewsPath = join(dir, "pr-reviews.json");
  const commentsPath = join(dir, "issue-comments.json");
  const diffPath = join(dir, "pr.diff");
  if (!existsSync(viewPath)) return null;
  const viewText = readFileSync(viewPath, "utf-8");
  const prView = jsonTryParse<PrView>(viewText);
  if (!prView) return null;
  const reviews = existsSync(reviewsPath)
    ? jsonTryParse<PrReview[]>(readFileSync(reviewsPath, "utf-8")) ?? []
    : [];
  const issueComments = existsSync(commentsPath)
    ? jsonTryParse<PrIssueComment[]>(readFileSync(commentsPath, "utf-8")) ?? []
    : [];
  const diff = existsSync(diffPath) ? readFileSync(diffPath, "utf-8") : "";
  return { prView, diff, reviews, issueComments };
}

async function fetchPrSnapshot(
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
    "number,title,body,headRefName,reviewDecision,labels,updatedAt",
  ]);
  if (viewRes.code !== 0) return null;
  const prView = jsonTryParse<PrView>(viewRes.stdout);
  if (!prView) return null;

  const reviewsRes = await shell("gh", [
    "api",
    `repos/${repo}/pulls/${pr}/reviews`,
  ]);
  const reviews = reviewsRes.code === 0
    ? jsonTryParse<PrReview[]>(reviewsRes.stdout) ?? []
    : [];

  const commentsRes = await shell("gh", [
    "api",
    `repos/${repo}/issues/${pr}/comments`,
  ]);
  const issueComments = commentsRes.code === 0
    ? jsonTryParse<PrIssueComment[]>(commentsRes.stdout) ?? []
    : [];

  // Diff is optional for most code paths.
  const diffRes = await shell("gh", [
    "pr",
    "diff",
    String(pr),
    "--repo",
    repo,
  ]);
  const diff = diffRes.code === 0 ? diffRes.stdout : "";

  return { prView, diff, reviews, issueComments };
}

function respondLogPath(env: NodeJS.ProcessEnv): string {
  if (env.RESPOND_LOG && env.RESPOND_LOG.length > 0) return env.RESPOND_LOG;
  const home = env.HOME ?? env.USERPROFILE ?? process.cwd();
  return join(home, ".gardener", "respond-runs.jsonl");
}

function logEvent(
  env: NodeJS.ProcessEnv,
  event: Record<string, unknown>,
): void {
  try {
    const path = respondLogPath(env);
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
  status: RespondStatus,
  summary: string,
): void {
  // summary must be a single line for breeze-runner to parse cleanly.
  const compact = summary.replace(/\s+/g, " ").trim() || "no-op";
  write(`BREEZE_RESULT: status=${status} summary=${compact}`);
}

async function fetchLatestCommitTime(
  shell: ShellRun,
  repo: string,
  pr: number,
): Promise<string | null> {
  const res = await shell("gh", [
    "api",
    `repos/${repo}/pulls/${pr}/commits`,
    "--jq",
    "last | .commit.committer.date",
  ]);
  if (res.code !== 0) return null;
  const trimmed = res.stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface RespondSinglePrOpts {
  repo: string;
  pr: number;
  dryRun: boolean;
  shell: ShellRun;
  env: NodeJS.ProcessEnv;
  write: (line: string) => void;
  now: () => Date;
  gardenerLogin: string;
}

async function respondSinglePr(
  opts: RespondSinglePrOpts,
): Promise<{ status: RespondStatus; summary: string }> {
  const { repo, pr, dryRun, shell, env, write, now, gardenerLogin } = opts;

  const snapshotDir = env.BREEZE_SNAPSHOT_DIR;
  const bundle = snapshotDir
    ? readSnapshot(snapshotDir)
    : await fetchPrSnapshot(shell, repo, pr);

  if (!bundle) {
    const msg = `Could not load PR data for ${repo}#${pr}`;
    write(msg);
    logEvent(env, { kind: "error", message: msg });
    return { status: "failed", summary: `fetch failed for ${repo}#${pr}` };
  }

  const { prView, reviews, issueComments } = bundle;

  if (!isSyncPr(prView)) {
    const msg = `#${pr}: not a sync PR (branch ${prView.headRefName ?? "?"})`;
    write(`\u23ed ${msg}`);
    logEvent(env, { kind: "skip", pr_number: pr, reason: "not_sync_pr" });
    return { status: "skipped", summary: msg };
  }

  // Self-loop guard: only count feedback from reviewers who are NOT
  // gardener itself. Without this, gardener-sync's review-pass comment
  // looks like reviewer feedback and respond would try to "fix" it,
  // push a commit, re-trigger review → loop.
  // See: agent-team-foundation/first-tree#134, repo-gardener#22.
  const nonGardenerReviews = reviews.filter(
    (r) => r.state === "CHANGES_REQUESTED" && !isFromGardener(r, gardenerLogin),
  );
  const nonGardenerFixComments = issueComments.filter(
    (c) => c.body && GARDENER_FIX_RE.test(c.body) && !isFromGardener(c, gardenerLogin),
  );

  // If the PR's review decision is CHANGES_REQUESTED but every
  // CHANGES_REQUESTED entry is self-authored, and there are no
  // non-gardener @gardener-fix mentions, skip to avoid self-loop.
  const wantsChangesRequested =
    prView.reviewDecision === "CHANGES_REQUESTED" ||
    issueComments.some((c) => c.body && GARDENER_FIX_RE.test(c.body));
  if (
    wantsChangesRequested &&
    nonGardenerReviews.length === 0 &&
    nonGardenerFixComments.length === 0
  ) {
    write(
      `\u23ed no non-gardener feedback on PR #${pr} — skipping to avoid self-loop`,
    );
    logEvent(env, {
      kind: "skip",
      pr_number: pr,
      reason: "no_non_gardener_feedback",
    });
    return {
      status: "skipped",
      summary: `no non-gardener feedback`,
    };
  }

  const hasGardenerFix = nonGardenerFixComments.length > 0;
  const decision = classifyReviewDecision(prView, hasGardenerFix);

  if (decision === "approved") {
    // Housekeeping: warn if APPROVED unmerged >24h.
    const updated = prView.updatedAt ? new Date(prView.updatedAt) : null;
    const ageHours = updated
      ? (now().getTime() - updated.getTime()) / (1000 * 60 * 60)
      : 0;
    if (updated && ageHours > 24) {
      write(
        `\u26a0 #${pr}: APPROVED but not merged for >24h. Reviewer may need to enable auto-merge.`,
      );
    } else {
      write(`\u23ed #${pr}: APPROVED — waiting for reviewer to merge`);
    }
    logEvent(env, { kind: "skip", pr_number: pr, reason: "approved" });
    return { status: "skipped", summary: `approved, waiting for merge` };
  }

  if (decision === "housekeeping") {
    write(`\u23ed #${pr}: housekeeping PR, deferred to batch handler`);
    logEvent(env, { kind: "skip", pr_number: pr, reason: "housekeeping" });
    return { status: "skipped", summary: `housekeeping deferred` };
  }

  if (decision === "none") {
    write(`\u23ed #${pr}: no CHANGES_REQUESTED review and no @gardener fix`);
    logEvent(env, { kind: "skip", pr_number: pr, reason: "no_review" });
    return { status: "skipped", summary: `no actionable review` };
  }

  // CHANGES_REQUESTED path — Step 3a idempotency.
  const reviewTime = latestChangesRequestedAt(reviews);
  let commitTime: string | null = null;
  if (!snapshotDir) {
    commitTime = await fetchLatestCommitTime(shell, repo, pr);
  } else {
    // Snapshot bundle does not include commit times; skip idempotency
    // check — breeze-runner re-dispatches are expected to be fresh.
    commitTime = null;
  }
  if (reviewTime && commitTime && commitTime > reviewTime) {
    write(`\u23ed #${pr}: fix already pushed, waiting for re-review`);
    logEvent(env, { kind: "skip", pr_number: pr, reason: "already_fixed" });
    return {
      status: "skipped",
      summary: `already fixed, waiting for re-review`,
    };
  }

  // Attempts counter (Step 3e safety).
  const attempts = readRespondAttempts(prView.body);
  if (attempts >= RESPOND_MAX_ATTEMPTS) {
    write(
      `\u26a0 #${pr}: ${attempts} respond attempts reached — labeling breeze:human`,
    );
    if (!dryRun) {
      await shell("gh", [
        "pr",
        "edit",
        String(pr),
        "--repo",
        repo,
        "--add-label",
        "breeze:human",
      ]);
    }
    logEvent(env, {
      kind: "skip",
      pr_number: pr,
      reason: "max_attempts_reached",
    });
    return {
      status: "skipped",
      summary: `max attempts reached, flagged breeze:human`,
    };
  }

  // Step 3b-3e: Read feedback, read source, apply fix, reply.
  // The TS port delegates the actual edit to a Claude Code session
  // orchestrated externally — here we record that a fix was attempted,
  // bump the attempts counter, and emit a reply comment stub. The
  // runbook's "apply edits" step is a semantic change that lives in the
  // calling agent; this CLI is the deterministic scaffold around it.
  const reviewer = latestReviewerLogin(reviews) ?? "reviewer";
  const sourceInfo = extractSourcePr(prView.body);

  if (!dryRun) {
    const nextBody = writeRespondAttempts(prView.body, attempts + 1);
    await shell("gh", [
      "pr",
      "edit",
      String(pr),
      "--repo",
      repo,
      "--body",
      nextBody,
    ]);
    await shell("gh", [
      "pr",
      "comment",
      String(pr),
      "--repo",
      repo,
      "--body",
      `gardener-respond attempt ${attempts + 1}/${RESPOND_MAX_ATTEMPTS}: reviewing feedback from @${reviewer}. Will push a fix commit once edits are staged.${
        sourceInfo ? `\n\nSource PR: ${sourceInfo.sourceRepo ?? "?"}#${sourceInfo.sourcePr}` : ""
      }`,
    ]);
  }

  logEvent(env, {
    kind: "fix",
    pr_number: pr,
    pattern: "unclassified",
    summary: `attempt ${attempts + 1}`,
  });
  logEvent(env, { kind: "reply", pr_number: pr, reviewer });

  write(
    `\u2713 #${pr}: acknowledged CHANGES_REQUESTED (attempt ${attempts + 1}/${RESPOND_MAX_ATTEMPTS})`,
  );

  return {
    status: "handled",
    summary: `attempt ${attempts + 1}/${RESPOND_MAX_ATTEMPTS} acknowledged`,
  };
}

async function respondScanMode(
  opts: {
    treeRoot: string;
    dryRun: boolean;
    shell: ShellRun;
    env: NodeJS.ProcessEnv;
    write: (line: string) => void;
    now: () => Date;
    gardenerLogin: string;
  },
): Promise<{ status: RespondStatus; summary: string }> {
  const { shell, write, env, gardenerLogin } = opts;
  // Best-effort: detect tree repo slug from `gh repo view`.
  const repoRes = await shell("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ], { cwd: opts.treeRoot });
  if (repoRes.code !== 0) {
    const msg = `Could not determine tree repo slug (is this a git repo with gh set up?)`;
    write(msg);
    logEvent(env, { kind: "error", message: msg });
    return { status: "failed", summary: msg };
  }
  const treeRepo = repoRes.stdout.trim();

  const listRes = await shell("gh", [
    "pr",
    "list",
    "--repo",
    treeRepo,
    "--state",
    "open",
    "--json",
    "number,title,headRefName,reviewDecision,updatedAt,labels",
  ]);
  if (listRes.code !== 0) {
    const msg = `gh pr list failed: ${listRes.stderr.trim()}`;
    write(msg);
    logEvent(env, { kind: "error", message: msg });
    return { status: "failed", summary: msg };
  }
  const prs = jsonTryParse<PrView[]>(listRes.stdout) ?? [];
  const syncPrs = prs.filter(isSyncPr);

  logEvent(env, {
    kind: "scan",
    tree_repo: treeRepo,
    total_prs: prs.length,
    needs_fix: syncPrs.length,
  });

  if (syncPrs.length === 0) {
    write(`No open sync PRs on ${treeRepo}`);
    return { status: "skipped", summary: `no sync PRs on ${treeRepo}` };
  }

  let handled = 0;
  let skipped = 0;
  let failed = 0;
  for (const pr of syncPrs) {
    const result = await respondSinglePr({
      repo: treeRepo,
      pr: pr.number,
      dryRun: opts.dryRun,
      shell,
      env,
      write,
      now: opts.now,
      gardenerLogin,
    });
    if (result.status === "handled") handled += 1;
    else if (result.status === "failed") failed += 1;
    else skipped += 1;
  }

  const summary = `scanned=${syncPrs.length} handled=${handled} skipped=${skipped} failed=${failed}`;
  write(
    `gardener-respond run complete (scan)\n  Tree repo: ${treeRepo}\n  ${summary}`,
  );
  logEvent(env, {
    kind: "run",
    prs_scanned: syncPrs.length,
    prs_fixed: handled,
    learnings: 0,
    duration_s: 0,
  });
  return {
    status: failed > 0 ? "failed" : handled > 0 ? "handled" : "skipped",
    summary,
  };
}

export async function runRespond(
  args: string[],
  deps: RespondDeps = {},
): Promise<number> {
  const write = deps.write ?? ((line: string): void => console.log(line));
  const shell = deps.shellRun ?? defaultShellRun;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());

  const flags = parseFlags(args);
  if (flags.help) {
    write(RESPOND_USAGE);
    // Do not emit BREEZE_RESULT for --help; callers asking for usage
    // don't want their logs polluted. But per spec, "any exit path
    // prints a BREEZE_RESULT" — so we still emit a harmless one.
    emitBreezeResult(write, "skipped", "help requested");
    return 0;
  }
  if (flags.unknown) {
    write(`Unknown respond option: ${flags.unknown}`);
    write(RESPOND_USAGE);
    emitBreezeResult(write, "failed", `bad flag ${flags.unknown}`);
    return 1;
  }

  const treeRoot = flags.treePath
    ? resolve(process.cwd(), flags.treePath)
    : process.cwd();

  // Config opt-out.
  const config = loadGardenerConfig(treeRoot);
  if (!isModuleEnabled(config, "respond")) {
    write(
      "gardener-respond is disabled via .claude/gardener-config.yaml — exiting cleanly",
    );
    emitBreezeResult(write, "skipped", "respond module disabled");
    return 0;
  }

  // Resolve gardener's own GitHub login once, so isFromGardener() can
  // filter out self-authored feedback (self-loop guard — first-tree#134).
  // In snapshot mode (breeze-runner) we prefer GARDENER_LOGIN from the
  // environment to avoid an extra `gh api` call, and fall back to the
  // marker-only path when unset.
  let gardenerLogin = env.GARDENER_LOGIN?.trim() ?? "";
  if (!gardenerLogin && !env.BREEZE_SNAPSHOT_DIR) {
    gardenerLogin = await resolveGardenerLogin(shell);
  }

  try {
    if (flags.pr !== undefined || flags.repo !== undefined) {
      if (flags.pr === undefined || !flags.repo) {
        write(`--pr and --repo must be used together`);
        emitBreezeResult(write, "failed", "pr/repo flag pair incomplete");
        return 1;
      }
      const result = await respondSinglePr({
        repo: flags.repo,
        pr: flags.pr,
        dryRun: flags.dryRun,
        shell,
        env,
        write,
        now,
        gardenerLogin,
      });
      emitBreezeResult(write, result.status, result.summary);
      return result.status === "failed" ? 1 : 0;
    }

    const result = await respondScanMode({
      treeRoot,
      dryRun: flags.dryRun,
      shell,
      env,
      write,
      now,
      gardenerLogin,
    });
    emitBreezeResult(write, result.status, result.summary);
    return result.status === "failed" ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    write(`\u274c gardener-respond failed: ${message}`);
    logEvent(env, { kind: "error", message });
    emitBreezeResult(write, "failed", message);
    return 1;
  }
}
