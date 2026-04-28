/**
 * TS port of `breeze-poll`.
 *
 * One-shot poll of GitHub notifications. Fetches the user's notifications
 * via `gh api`, enriches each PR/Issue with labels + state via a batched
 * GraphQL query, classifies into `breeze_status`, then writes `inbox.json`
 * and appends `new` / `transition` events to `activity.log`.
 *
 * Reuses the shared core modules:
 *   - `runtime/gh.ts`        : `gh` subprocess wrapper
 *   - `runtime/classifier.ts`: label → status derivation
 *   - `runtime/store.ts`     : atomic inbox writer under advisory lock
 *   - `runtime/activity-log.ts`: append-only JSONL writer
 *   - `runtime/paths.ts`     : `$AUTO_DIR` layout
 *
 * Spec references:
 *   - the inbox/activity-log schema (historical migration doc, now removed; see git history) §1 (inbox) and §2 (activity)
 *   - the status state-machine spec (historical migration doc, now removed; see git history) (classifier precedence)
 *   - Rust parity: `fetcher.rs::poll_once`
 *
 * Differences vs. the bash script:
 *   - No `.poll.pid` lockfile — we rely on `updateInbox`'s advisory lock.
 *   - No inline `jq`; all parsing happens in JS.
 *   - Config file (`config.yaml` repos filter) parsing is deferred; the
 *     Rust fetcher uses CLI flags (`--repos`). Phase 3 will decide how to
 *     surface it here.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import { appendActivityEvent } from "../runtime/activity-log.js";
import { classifyAutoStatus } from "../runtime/classifier.js";
import { loadAutoConfig } from "../runtime/config.js";
import { GhClient, GhExecError } from "../runtime/gh.js";
import { resolveAutoPaths } from "../runtime/paths.js";
import { updateInbox } from "../runtime/store.js";
import { shouldProcessReason } from "../runtime/task-kind.js";
import {
  type GhState,
  type Inbox,
  type InboxEntry,
} from "../runtime/types.js";

export interface PollIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface PollDeps {
  io?: PollIO;
  gh?: GhClient;
  paths?: ReturnType<typeof resolveAutoPaths>;
  now?: () => Date;
  appendActivity?: typeof appendActivityEvent;
  /** `claimTimeoutSecs` override; default from loadAutoConfig. */
  claimTimeoutSecs?: number;
}

const DEFAULT_IO: PollIO = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

const LABEL_BATCH_SIZE = 30;

/** Seconds-precision ISO-8601 UTC, matching `date -u +%Y-%m-%dT%H:%M:%SZ`. */
function formatUtcIso(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** Raw GitHub notification as returned by `/notifications?participating=true`. */
interface RawNotification {
  id?: string;
  reason?: string;
  unread?: boolean;
  updated_at?: string;
  subject?: {
    title?: string;
    url?: string | null;
    latest_comment_url?: string | null;
    type?: string;
  };
  repository?: {
    full_name?: string;
  };
}

function priorityForReason(reason: string): number {
  switch (reason) {
    case "review_requested":
      return 1;
    case "mention":
    case "team_mention":
      return 2;
    default:
      return 5;
  }
}

function extractTrailingNumber(url: string): number | null {
  if (!url.includes("/pulls/") && !url.includes("/issues/")) return null;
  const last = url.split("/").pop();
  if (!last) return null;
  const match = /^(\d+)/u.exec(last);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}

function htmlUrlFor(
  host: string,
  repo: string,
  subjectType: string,
  number: number | null,
): string {
  const base = `https://${host}/${repo}`;
  if (subjectType === "PullRequest" && number !== null) {
    return `${base}/pull/${number}`;
  }
  if (subjectType === "Issue" && number !== null) {
    return `${base}/issues/${number}`;
  }
  return base;
}

/**
 * Parse raw `gh api /notifications` JSON response (array of notifications,
 * or concatenated arrays when `--paginate` is used) into unclassified entries.
 * Filters out CheckSuite / Commit subjects and any notification reason that
 * is not an explicit mention or review request.
 */
export function parseNotifications(
  rawJsonPages: readonly string[],
  host: string,
): InboxEntry[] {
  const entries: InboxEntry[] = [];
  const seenIds = new Set<string>();
  for (const raw of rawJsonPages) {
    const items = parseNotificationPage(raw);
    if (!items) continue;
    for (const item of items) {
      const entry = mapNotificationItem(item, host, seenIds);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

function parseNotificationPage(raw: string): RawNotification[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed as RawNotification[];
}

function mapNotificationItem(
  item: RawNotification,
  host: string,
  seenIds: Set<string>,
): InboxEntry | null {
  const accepted = acceptNotification(item, seenIds);
  if (!accepted) return null;
  const { id, subjectType, repo, reason } = accepted;
  const url = item.subject?.url ?? "";
  const number = typeof url === "string" ? extractTrailingNumber(url) : null;
  seenIds.add(id);
  return {
    id,
    type: subjectType,
    reason,
    repo,
    title: item.subject?.title ?? "",
    url: url ?? "",
    last_actor: item.subject?.latest_comment_url ?? url ?? "",
    updated_at: item.updated_at ?? "",
    unread: Boolean(item.unread),
    priority: priorityForReason(reason),
    number,
    html_url: htmlUrlFor(host, repo, subjectType, number),
    gh_state: null,
    labels: [],
    breeze_status: "new",
  };
}

/**
 * Validate the notification metadata required to admit it into the inbox.
 * Returns the normalized fields, or `null` to skip.
 */
function acceptNotification(
  item: RawNotification,
  seenIds: ReadonlySet<string>,
): { id: string; subjectType: string; repo: string; reason: string } | null {
  const id = item.id;
  if (typeof id !== "string" || id.length === 0) return null;
  if (seenIds.has(id)) return null;
  const subjectType = item.subject?.type ?? "";
  if (subjectType === "CheckSuite" || subjectType === "Commit") return null;
  const repo = item.repository?.full_name ?? "";
  if (!repo) return null;
  const reason = item.reason ?? "";
  if (!shouldProcessReason(reason)) return null;
  return { id, subjectType, repo, reason };
}

/** Sort: priority asc, updated_at desc, id asc. Matches `sort_entries`. */
export function sortEntries(entries: InboxEntry[]): void {
  entries.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.updated_at !== b.updated_at) {
      return a.updated_at < b.updated_at ? 1 : -1;
    }
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

/** Build a batched GraphQL query for the `repo` at `owner/name`. */
function buildLabelQuery(
  owner: string,
  name: string,
  batch: ReadonlyArray<{ number: number; isPR: boolean }>,
): string {
  let fragments = "";
  for (const { number, isPR } of batch) {
    const kind = isPR ? "pullRequest" : "issue";
    fragments += ` n${number}: ${kind}(number: ${number}) { number state labels(first: 10) { nodes { name } } }`;
  }
  return `query { repository(owner: "${owner}", name: "${name}") {${fragments} } }`;
}

interface LabelInfo {
  gh_state: GhState | null;
  labels: string[];
}

interface GraphQLLabelResponse {
  data?: {
    repository?: Record<
      string,
      {
        number?: number;
        state?: string;
        labels?: { nodes?: Array<{ name?: string }> };
      } | null
    > | null;
  };
}

function parseLabelResponse(
  response: string,
): Array<{ number: number; gh_state: GhState | null; labels: string[] }> {
  let parsed: GraphQLLabelResponse;
  try {
    parsed = JSON.parse(response) as GraphQLLabelResponse;
  } catch {
    return [];
  }
  const repo = parsed.data?.repository;
  if (!repo) return [];
  const rows: Array<{
    number: number;
    gh_state: GhState | null;
    labels: string[];
  }> = [];
  for (const node of Object.values(repo)) {
    if (!node || typeof node !== "object") continue;
    const number = node.number;
    if (typeof number !== "number") continue;
    const rawState = node.state;
    const gh_state: GhState | null =
      rawState === "OPEN" || rawState === "CLOSED" || rawState === "MERGED"
        ? rawState
        : null;
    const labelNodes = node.labels?.nodes ?? [];
    const labels = labelNodes
      .map((n) => n?.name)
      .filter((n): n is string => typeof n === "string");
    rows.push({ number, gh_state, labels });
  }
  return rows;
}

/**
 * Enrich entries with `{labels, gh_state}` by issuing batched GraphQL
 * queries — one per repo, chunked at `LABEL_BATCH_SIZE` items per request
 * to stay under GitHub's complexity limit.
 *
 * Mutates `entries` in place. Returns a warning string if any repo's
 * enrichment failed; otherwise `null`.
 */
export function enrichWithLabels(
  entries: InboxEntry[],
  gh: GhClient,
  host: string,
): string | null {
  const byRepo = new Map<string, Array<{ number: number; isPR: boolean }>>();
  for (const entry of entries) {
    if (entry.number === null) continue;
    const isPR = entry.type === "PullRequest";
    const isIssue = entry.type === "Issue";
    if (!isPR && !isIssue) continue;
    const list = byRepo.get(entry.repo) ?? [];
    list.push({ number: entry.number, isPR });
    byRepo.set(entry.repo, list);
  }

  const info = new Map<string, LabelInfo>();
  const warnings: string[] = [];

  for (const [repo, items] of byRepo) {
    const slashIdx = repo.indexOf("/");
    if (slashIdx <= 0) continue;
    const owner = repo.slice(0, slashIdx);
    const name = repo.slice(slashIdx + 1);

    // Deduplicate, sort by number for stable output.
    const sorted = [...items].sort((a, b) => a.number - b.number);
    const deduped: Array<{ number: number; isPR: boolean }> = [];
    for (const item of sorted) {
      if (
        deduped.length === 0 ||
        deduped[deduped.length - 1].number !== item.number
      ) {
        deduped.push(item);
      }
    }

    for (let i = 0; i < deduped.length; i += LABEL_BATCH_SIZE) {
      const batch = deduped.slice(i, i + LABEL_BATCH_SIZE);
      const query = buildLabelQuery(owner, name, batch);
      const result = gh.run([
        "api",
        "graphql",
        "-H",
        `GH-Host: ${host}`,
        "-f",
        `query=${query}`,
      ]);
      if (result.status !== 0) {
        warnings.push(`GraphQL label enrichment for ${repo} failed`);
        continue;
      }
      const rows = parseLabelResponse(result.stdout);
      for (const row of rows) {
        info.set(`${repo}/${row.number}`, {
          gh_state: row.gh_state,
          labels: row.labels,
        });
      }
    }
  }

  for (const entry of entries) {
    if (entry.number === null) continue;
    const row = info.get(`${entry.repo}/${entry.number}`);
    if (!row) continue;
    entry.gh_state = row.gh_state;
    entry.labels = [...row.labels];
  }

  return warnings.length > 0 ? warnings.join("; ") : null;
}

/** Derive `breeze_status` for every entry in place (classifier is pure). */
export function classifyEntries(entries: InboxEntry[]): void {
  for (const entry of entries) {
    entry.breeze_status = classifyAutoStatus({
      labels: entry.labels,
      ghState: entry.gh_state,
    });
  }
}

interface DiffEvent {
  kind: "new" | "transition";
  entry: InboxEntry;
  from?: InboxEntry["breeze_status"];
  to?: InboxEntry["breeze_status"];
}

/**
 * Compare the old inbox to the new entries and produce activity events.
 *
 * Mirrors `diff_and_log` (`fetcher.rs:539-581`):
 *   - `new` event when an id wasn't previously seen
 *   - `transition` event when `breeze_status` changed, EXCEPT
 *     `new → done` (auto-close/merge noise; spec 3 §8)
 */
export function diffEvents(
  old: Inbox | null,
  next: readonly InboxEntry[],
): DiffEvent[] {
  const prevStatuses = new Map<string, InboxEntry["breeze_status"]>();
  if (old) {
    for (const entry of old.notifications) {
      prevStatuses.set(entry.id, entry.breeze_status);
    }
  }
  const events: DiffEvent[] = [];
  for (const entry of next) {
    const prev = prevStatuses.get(entry.id);
    if (prev === undefined) {
      events.push({ kind: "new", entry });
      continue;
    }
    if (prev === entry.breeze_status) continue;
    if (prev === "new" && entry.breeze_status === "done") continue;
    events.push({
      kind: "transition",
      entry,
      from: prev,
      to: entry.breeze_status,
    });
  }
  return events;
}

/** Remove claim directories whose `claimed_at` is older than `timeoutSecs`. */
function cleanupExpiredClaims(
  claimsDir: string,
  timeoutSecs: number,
  now: () => Date,
): void {
  if (!existsSync(claimsDir)) return;
  let dirs: string[];
  try {
    dirs = readdirSync(claimsDir);
  } catch {
    return;
  }
  for (const name of dirs) {
    const claimDir = join(claimsDir, name);
    const marker = join(claimDir, "claimed_at");
    if (!existsSync(marker)) continue;
    try {
      const contents = readFileSync(marker, "utf-8").trim();
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u.exec(
        contents,
      );
      let claimedMs: number | null = null;
      if (m) {
        claimedMs = Date.UTC(
          Number(m[1]),
          Number(m[2]) - 1,
          Number(m[3]),
          Number(m[4]),
          Number(m[5]),
          Number(m[6]),
        );
      } else {
        const fallback = Date.parse(contents);
        claimedMs = Number.isFinite(fallback) ? fallback : null;
      }
      if (claimedMs === null) continue;
      const ageSecs = (now().getTime() - claimedMs) / 1000;
      if (ageSecs >= timeoutSecs) {
        rmSync(claimDir, { recursive: true, force: true });
      }
    } catch {
      // ignore — next poll retries
    }
  }
}

/**
 * Split `gh api --paginate` stdout into individual JSON array pages.
 *
 * `gh` concatenates paginated arrays as `[...][...][...]` with no
 * separator. We walk the string and track bracket depth to carve out each
 * top-level array.
 */
export function splitConcatenatedJsonArrays(raw: string): string[] {
  const pages: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "]") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        pages.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  if (pages.length === 0 && raw.trim().length > 0) {
    // Not a recognizable array stream — return the raw text as a single
    // page; the parser will drop it if malformed.
    pages.push(raw);
  }
  return pages;
}

/**
 * Entry point for `first-tree breeze poll`.
 *
 * Exit codes:
 *   - 0 on successful poll (even if GitHub API degraded — we keep the
 *     existing inbox + print a warning to stderr, matching the bash script).
 *   - 1 on local setup errors (gh not on PATH, gh not authenticated,
 *     schema validation failure on the existing inbox).
 */
export async function runPoll(
  argv: readonly string[],
  deps: PollDeps = {},
): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    const io = deps.io ?? DEFAULT_IO;
    io.stdout("Usage: auto poll");
    io.stdout("");
    io.stdout("Run a single notifications poll: fetch, enrich, classify,");
    io.stdout("then write inbox.json + append activity.log events.");
    io.stdout("");
    io.stdout("Honors $AUTO_DIR (default ~/.first-tree/auto).");
    return 0;
  }

  const io = deps.io ?? DEFAULT_IO;
  const config = loadAutoConfig();
  const paths = deps.paths ?? resolveAutoPaths();
  const gh = deps.gh ?? new GhClient();
  const now = deps.now ?? (() => new Date());
  const append = deps.appendActivity ?? appendActivityEvent;
  const claimTimeoutSecs = deps.claimTimeoutSecs ?? config.claimTimeoutSecs;

  if (!existsSync(paths.root)) mkdirSync(paths.root, { recursive: true });

  // Preflight: `gh auth status`. On failure, exit 1 (matches bash).
  const authCheck = gh.run(["auth", "status"]);
  if (authCheck.status !== 0) {
    const firstLine = authCheck.stderr.split("\n")[0]?.trim() ?? "";
    io.stderr(
      `ERROR: gh not authenticated (run \`gh auth login\`). ${firstLine}`.trim(),
    );
    return 1;
  }

  const fetched = fetchNotificationPages(gh, io);
  if (fetched === "skipped") return 0;

  const entries = parseNotifications(fetched, config.host);
  sortEntries(entries);

  const enrichmentWarning = enrichWithLabels(entries, gh, config.host);
  if (enrichmentWarning) io.stderr(`WARN: ${enrichmentWarning}`);
  classifyEntries(entries);

  const pollTs = formatUtcIso(now());
  const nextInbox: Inbox = { last_poll: pollTs, notifications: entries };

  // Capture old state + diff inside the mutator so the lock window covers
  // the read→diff→write sequence.
  let diff: DiffEvent[] = [];
  await updateInbox(
    (current) => {
      diff = diffEvents(current, entries);
      return nextInbox;
    },
    { inboxPath: paths.inbox },
  );

  appendDiffEvents(diff, append, paths.activityLog, pollTs);
  cleanupExpiredClaims(paths.claimsDir, claimTimeoutSecs, now);

  const total = entries.length;
  const newCount = entries.filter((e) => e.breeze_status === "new").length;
  const timeOnly = pollTs.slice(11, 19);
  io.stdout(`auto: polled ${timeOnly} — ${total} notifications (${newCount} new)`);
  return 0;
}

/**
 * Fetch + paginate the GitHub notifications endpoint. Returns the page
 * payloads, or "skipped" if the API call failed in a way that should
 * leave the existing inbox alone (matches the bash script).
 */
function fetchNotificationPages(
  gh: GhClient,
  io: PollIO,
): string[] | "skipped" {
  try {
    // `--paginate` concatenates pages to stdout as `[...][...][...]`
    // with no separator; `splitConcatenatedJsonArrays` carves them back
    // apart.
    const stdout = gh.runChecked("fetch notifications", [
      "api",
      // See #251: `all=true` bypassed GitHub's spam filter.
      // `participating=true` restricts to direct-participation
      // notifications.
      "/notifications?participating=true",
      "--paginate",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
    ]);
    return splitConcatenatedJsonArrays(stdout);
  } catch (err) {
    if (err instanceof GhExecError) {
      io.stderr(`WARN: GitHub API failed, skipping (${err.message})`);
      return "skipped";
    }
    throw err;
  }
}

function appendDiffEvents(
  diff: DiffEvent[],
  append: typeof appendActivityEvent,
  activityLog: string,
  pollTs: string,
): void {
  // Activity log has its own append-only semantics; no need to serialize
  // with the inbox writer.
  for (const ev of diff) {
    if (ev.kind === "new") {
      append(activityLog, {
        ts: pollTs,
        event: "new",
        id: ev.entry.id,
        type: ev.entry.type,
        repo: ev.entry.repo,
        title: ev.entry.title,
        url: ev.entry.html_url,
      });
    } else if (ev.kind === "transition" && ev.from && ev.to) {
      append(activityLog, {
        ts: pollTs,
        event: "transition",
        id: ev.entry.id,
        type: ev.entry.type,
        repo: ev.entry.repo,
        title: ev.entry.title,
        url: ev.entry.html_url,
        from: ev.from,
        to: ev.to,
      });
    }
  }
}

export default runPoll;
