/**
 * Auto-revert `github-scan:human` → `new` when the human comments back
 * (issue #358) or pushes a fix commit (issue #383).
 *
 * Spec: when the daemon polls an item classified `human` and a qualifying
 * human signal is observed *after* the label was applied, the daemon
 * strips `github-scan:human` from the item. The classifier (which is
 * pure and unchanged) then derives `new` on the next cycle and the
 * dispatcher picks the item up.
 *
 * Comment guards (issue #358 acceptance criteria, updated by issue #382):
 *   1. Comment author MUST NOT be the agent itself (the daemon's identity).
 *   2. Reactions alone do NOT count as a comment (callers pass real comments only;
 *      defensively, empty-body comments are also rejected).
 *   3. The comment's `created_at` MUST be strictly after the label's
 *      `created_at` / label-event timestamp.
 *
 * Note (issue #382): the original `body.trim().length > 20` guard was dropped
 * because it produced false negatives for legitimate short approvals
 * (`LGTM`, `go ahead`, `请继续推进`). Reactions are not comments in the
 * GitHub REST API, so the "filter emoji acks" rationale was already moot.
 *
 * Commit guards (issue #383, applies to PullRequest entries only):
 *   1. Commit author MUST NOT be the agent itself.
 *   2. The commit's `committer.date` MUST be strictly after the label
 *      timestamp. We use `committer.date` (when the commit landed on the
 *      branch on GitHub) rather than `author.date` so force-push, rebase,
 *      and amend are handled correctly — a force-push of an old commit
 *      onto the branch after the label was applied still triggers revert.
 *
 * This module exposes:
 *   - `shouldAutoRevertHuman` — the pure decision function (testable in isolation).
 *   - `autoRevertHumanLabels` — the in-place label remover wired to a `GhClient`.
 *
 * No I/O happens in `shouldAutoRevertHuman`. The driver does all the
 * `gh` calls so unit tests can stub at the gh boundary.
 */

import type { GhClient } from "./gh.js";
import type { InboxEntry } from "./types.js";

/** Page size used for the timeline + comments REST endpoints. */
export const AUTO_REVERT_PAGE_SIZE = 100;

/**
 * Hard cap on the number of pages walked per fetch. A long-running, very
 * noisy issue can in theory accumulate thousands of timeline events; we
 * stop after this many pages to avoid runaway fetches and emit a warning
 * (issue #365). 50 pages * 100 per page = 5,000 events, which is far
 * past any realistic human-review thread.
 */
export const AUTO_REVERT_MAX_PAGES = 50;

/** A single issue comment, as returned by `GET /repos/{r}/issues/{n}/comments`. */
export interface IssueComment {
  /** Comment author's GitHub login (case-insensitive when compared). */
  author: string;
  /** Raw markdown body. May be empty for reaction-only events (those are not comments). */
  body: string;
  /** ISO-8601 timestamp the comment was created at. */
  createdAt: string;
}

/**
 * A single commit on a PR, as returned by `GET /repos/{r}/pulls/{n}/commits`.
 *
 * Note (issue #383): `committedAt` corresponds to `commit.committer.date`
 * — the moment the commit landed on the branch on GitHub — NOT
 * `commit.author.date`. The two diverge on force-push, rebase, and
 * `git commit --amend`; using `committer.date` correctly captures
 * "this commit appeared on the PR branch after the label was applied".
 */
export interface PrCommit {
  /** Commit author's GitHub login (case-insensitive when compared). May be `null` for un-attributed commits (e.g. legacy email-only). */
  author: string | null;
  /** ISO-8601 `commit.committer.date` — when the commit landed on the branch. */
  committedAt: string;
}

export interface AutoRevertInput {
  /** GitHub login of the daemon agent — comments and commits authored by this login are ignored. */
  agentLogin: string;
  /** Timestamp the `github-scan:human` label was applied (ISO-8601). */
  labelAppliedAt: string;
  /** Comments on the item, in any order. */
  comments: readonly IssueComment[];
  /**
   * Commits on the PR, in any order. Empty / omitted for non-PR entries
   * (issues do not have commits). Issue #383.
   */
  commits?: readonly PrCommit[];
}

/**
 * Pure decision function: returns `true` when the item should have its
 * `github-scan:human` label removed.
 *
 * Returns `false` (and does nothing) when none of the comments pass all
 * four guards. See module docstring for the guard list.
 */
export function shouldAutoRevertHuman(input: AutoRevertInput): boolean {
  const labelTs = Date.parse(input.labelAppliedAt);
  if (Number.isNaN(labelTs)) return false;

  const agentLogin = input.agentLogin.toLowerCase();
  for (const comment of input.comments) {
    // Guard 1: own-comment ignored.
    if (comment.author.toLowerCase() === agentLogin) continue;

    // Guard 2: reactions alone do not count — callers pass only real
    // comments here, but we also defensively reject empty bodies.
    if (comment.body.length === 0) continue;

    // Guard 3: must be strictly after the label timestamp.
    const commentTs = Date.parse(comment.createdAt);
    if (Number.isNaN(commentTs)) continue;
    if (commentTs <= labelTs) continue;

    return true;
  }

  // Issue #383: a qualifying author push on a PR also fires the revert.
  // Same author / timestamp guards as comments, but timestamps come from
  // `commit.committer.date` (force-push correctness — see module doc).
  for (const commit of input.commits ?? []) {
    // Guard 1: own-commit ignored. Some commits have no attributed
    // author login (e.g. email-only); those cannot match the agent and
    // are treated as non-agent.
    if (commit.author !== null && commit.author.toLowerCase() === agentLogin) continue;

    // Guard 2: must be strictly after the label timestamp.
    const ts = Date.parse(commit.committedAt);
    if (Number.isNaN(ts)) continue;
    if (ts <= labelTs) continue;

    return true;
  }
  return false;
}

function parseCommentsPage(stdout: string): IssueComment[] | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((raw): IssueComment | null => {
        if (typeof raw !== "object" || raw === null) return null;
        const r = raw as {
          user?: { login?: unknown } | null;
          body?: unknown;
          created_at?: unknown;
        };
        const login = r.user?.login;
        const body = r.body;
        const createdAt = r.created_at;
        if (typeof login !== "string") return null;
        if (typeof createdAt !== "string") return null;
        return {
          author: login,
          body: typeof body === "string" ? body : "",
          createdAt,
        };
      })
      .filter((c): c is IssueComment => c !== null);
  } catch {
    return null;
  }
}

/**
 * Fetch comments for an issue/PR (number) via the REST API.
 *
 * Pagination (issue #365): walks pages in descending `created_at` order
 * so that the newest comments arrive first. Stops early when a page's
 * first (newest) comment was created at-or-before `labelAppliedAt` —
 * any later page would only contain even older comments, all of which
 * are pre-label by definition and cannot trigger a revert. When
 * `labelAppliedAt` is omitted the early-exit is disabled and we only
 * stop on the natural end-of-pages signal (a short page).
 *
 * Hard cap of {@link AUTO_REVERT_MAX_PAGES} pages prevents runaway
 * fetches on truly massive threads; a `console.warn` is emitted if the
 * cap engages.
 *
 * Returns `null` on error so the caller can degrade gracefully — a
 * failed comment fetch should NEVER strip the label.
 */
export function fetchIssueComments(
  gh: GhClient,
  repo: string,
  number: number,
  labelAppliedAt?: string,
): IssueComment[] | null {
  const labelMs = labelAppliedAt !== undefined ? Date.parse(labelAppliedAt) : Number.NaN;
  const haveLabelTs = !Number.isNaN(labelMs);

  const all: IssueComment[] = [];
  for (let page = 1; page <= AUTO_REVERT_MAX_PAGES; page++) {
    const result = gh.run([
      "api",
      `/repos/${repo}/issues/${number}/comments?per_page=${AUTO_REVERT_PAGE_SIZE}&page=${page}&sort=created&direction=desc`,
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
    ]);
    if (result.status !== 0) return null;
    const pageComments = parseCommentsPage(result.stdout);
    if (pageComments === null) return null;

    if (pageComments.length === 0) return all;

    // Early exit: page is newest-first, so if the first comment of this
    // page is already at-or-before the label timestamp, every later
    // page is older and cannot contribute a post-label comment. Check
    // before pushing to avoid accumulating an entire pre-label page that
    // would just be filtered downstream.
    if (haveLabelTs) {
      const firstMs = Date.parse(pageComments[0]!.createdAt);
      if (!Number.isNaN(firstMs) && firstMs <= labelMs) return all;
    }

    all.push(...pageComments);

    // Natural end of results: a short page means no more.
    if (pageComments.length < AUTO_REVERT_PAGE_SIZE) return all;

    if (page === AUTO_REVERT_MAX_PAGES) {
      console.warn(
        `auto-revert: comments fetch hit ${AUTO_REVERT_MAX_PAGES}-page cap for ${repo}#${number}; older comments may be ignored`,
      );
    }
  }
  return all;
}

function parseCommitsPage(stdout: string): PrCommit[] | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((raw): PrCommit | null => {
        if (typeof raw !== "object" || raw === null) return null;
        // The PR commits endpoint shape:
        //   { author: { login } | null,
        //     commit: { committer: { date }, author: { date } } }
        const r = raw as {
          author?: { login?: unknown } | null;
          commit?: {
            committer?: { date?: unknown } | null;
          } | null;
        };
        const login = r.author?.login;
        const committedAt = r.commit?.committer?.date;
        if (typeof committedAt !== "string") return null;
        return {
          author: typeof login === "string" ? login : null,
          committedAt,
        };
      })
      .filter((c): c is PrCommit => c !== null);
  } catch {
    return null;
  }
}

/**
 * Fetch commits on a PR via `GET /repos/{owner}/{repo}/pulls/{n}/commits`
 * (issue #383).
 *
 * Pagination: walks pages forward (the endpoint does not support
 * `direction=desc`, returns commits oldest-first). No early-exit: even
 * a force-push of an old commit can land on the branch *after* the
 * label was applied, and we use `committer.date` to detect that. Hard
 * cap of {@link AUTO_REVERT_MAX_PAGES} pages with a `console.warn` if
 * the cap engages.
 *
 * Returns `null` on error so the caller degrades gracefully — a failed
 * commit fetch must NEVER strip the label.
 */
export function fetchPrCommits(gh: GhClient, repo: string, number: number): PrCommit[] | null {
  const all: PrCommit[] = [];
  for (let page = 1; page <= AUTO_REVERT_MAX_PAGES; page++) {
    const result = gh.run([
      "api",
      `/repos/${repo}/pulls/${number}/commits?per_page=${AUTO_REVERT_PAGE_SIZE}&page=${page}`,
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
    ]);
    if (result.status !== 0) return null;
    const pageCommits = parseCommitsPage(result.stdout);
    if (pageCommits === null) return null;

    if (pageCommits.length === 0) return all;
    all.push(...pageCommits);

    if (pageCommits.length < AUTO_REVERT_PAGE_SIZE) return all;

    if (page === AUTO_REVERT_MAX_PAGES) {
      console.warn(
        `auto-revert: PR commits fetch hit ${AUTO_REVERT_MAX_PAGES}-page cap for ${repo}#${number}; older commits may be ignored`,
      );
    }
  }
  return all;
}

interface TimelineLabelHit {
  createdAt: string;
  ms: number;
}

interface TimelinePageParse {
  hits: TimelineLabelHit[];
  pageLen: number;
}

function parseTimelinePage(stdout: string): TimelinePageParse | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return null;
    const hits: TimelineLabelHit[] = [];
    for (const raw of parsed) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as {
        event?: unknown;
        label?: { name?: unknown } | null;
        created_at?: unknown;
      };
      if (r.event !== "labeled") continue;
      const labelName = r.label?.name;
      if (labelName !== "github-scan:human") continue;
      if (typeof r.created_at !== "string") continue;
      const ms = Date.parse(r.created_at);
      if (Number.isNaN(ms)) continue;
      hits.push({ createdAt: r.created_at, ms });
    }
    return { hits, pageLen: parsed.length };
  } catch {
    return null;
  }
}

/**
 * Find the most recent `github-scan:human` label-applied timestamp from
 * the issue timeline. Returns `null` on error or when the label has
 * never been applied (which should not happen if `entry.labels`
 * contains it, but we degrade gracefully).
 *
 * Pagination (issue #365): walks pages forward, tracking the latest
 * `labeled` event for `github-scan:human` across all pages. Stops on a
 * short or empty page (natural end of results). Capped at
 * {@link AUTO_REVERT_MAX_PAGES} pages with a `console.warn` when the
 * cap engages. The timeline endpoint returns events oldest-first, so
 * hitting the cap means the *most recent* events are clipped — which
 * is also the operationally worst failure mode, since a re-label after
 * the clipped boundary would be the one we'd want to see.
 */
export function fetchHumanLabelAppliedAt(
  gh: GhClient,
  repo: string,
  number: number,
): string | null {
  let latest: string | null = null;
  let latestMs = -Infinity;

  for (let page = 1; page <= AUTO_REVERT_MAX_PAGES; page++) {
    const result = gh.run([
      "api",
      `/repos/${repo}/issues/${number}/timeline?per_page=${AUTO_REVERT_PAGE_SIZE}&page=${page}`,
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      "-H",
      "Accept: application/vnd.github.mockingbird-preview+json",
    ]);
    if (result.status !== 0) return null;

    const parsed = parseTimelinePage(result.stdout);
    if (parsed === null) return null;
    for (const hit of parsed.hits) {
      if (hit.ms > latestMs) {
        latestMs = hit.ms;
        latest = hit.createdAt;
      }
    }

    if (parsed.pageLen === 0) return latest;
    if (parsed.pageLen < AUTO_REVERT_PAGE_SIZE) return latest;

    if (page === AUTO_REVERT_MAX_PAGES) {
      console.warn(
        `auto-revert: timeline fetch hit ${AUTO_REVERT_MAX_PAGES}-page cap for ${repo}#${number}; most-recent history may be clipped`,
      );
    }
  }
  return latest;
}

export interface AutoRevertDeps {
  gh: GhClient;
  agentLogin: string;
  /** Test seam: override comment-fetch (default uses `fetchIssueComments`). */
  fetchComments?: (
    gh: GhClient,
    repo: string,
    number: number,
    labelAppliedAt?: string,
  ) => IssueComment[] | null;
  /** Test seam: override timeline-fetch. */
  fetchLabelAppliedAt?: (gh: GhClient, repo: string, number: number) => string | null;
  /** Test seam: override PR-commits fetch (default uses `fetchPrCommits`). Issue #383. */
  fetchCommits?: (gh: GhClient, repo: string, number: number) => PrCommit[] | null;
}

export interface AutoRevertOutcome {
  /** ids of entries whose `github-scan:human` label was successfully removed. */
  reverted: string[];
  /** Non-fatal warnings (failed fetches, etc). */
  warnings: string[];
}

/**
 * Iterate `entries` looking for items currently labeled
 * `github-scan:human`. For each, fetch the label-event timestamp and
 * the comment list, apply the four guards, and — when they pass —
 * remove the label both via `gh.removeLabel` and from the in-memory
 * `entry.labels` array.
 *
 * Mutates entries in place when reverting so the subsequent
 * `classifyEntries` call naturally derives `new` for them.
 *
 * Spec note: this runs once per poll cycle. The poller keeps a per-id
 * tombstone (`reverted`) only for the duration of a single cycle —
 * there is no race within a cycle because we mutate `entry.labels` and
 * then classify. On the *next* cycle, GraphQL re-reads the live label
 * set, which will no longer contain `github-scan:human`, so we will
 * not retry.
 */
export function autoRevertHumanLabels(
  entries: InboxEntry[],
  deps: AutoRevertDeps,
): AutoRevertOutcome {
  const fetchComments = deps.fetchComments ?? fetchIssueComments;
  const fetchLabelAppliedAt = deps.fetchLabelAppliedAt ?? fetchHumanLabelAppliedAt;
  const fetchCommits = deps.fetchCommits ?? fetchPrCommits;

  const reverted: string[] = [];
  const warnings: string[] = [];

  for (const entry of entries) {
    if (entry.number === null) continue;
    if (!entry.labels.includes("github-scan:human")) continue;

    const labelAppliedAt = fetchLabelAppliedAt(deps.gh, entry.repo, entry.number);
    if (!labelAppliedAt) {
      warnings.push(
        `auto-revert: missing label-applied timestamp for ${entry.repo}#${entry.number}`,
      );
      continue;
    }

    const comments = fetchComments(deps.gh, entry.repo, entry.number, labelAppliedAt);
    if (!comments) {
      warnings.push(`auto-revert: comment fetch failed for ${entry.repo}#${entry.number}`);
      continue;
    }

    // Issue #383: PR entries also qualify on author push. Issues do not
    // have commits, so we skip the fetch entirely for non-PRs to avoid
    // a wasted (404) round-trip.
    let commits: readonly PrCommit[] = [];
    if (entry.type === "PullRequest") {
      const fetched = fetchCommits(deps.gh, entry.repo, entry.number);
      if (!fetched) {
        warnings.push(`auto-revert: PR commits fetch failed for ${entry.repo}#${entry.number}`);
        continue;
      }
      commits = fetched;
    }

    const decide = shouldAutoRevertHuman({
      agentLogin: deps.agentLogin,
      labelAppliedAt,
      comments,
      commits,
    });
    if (!decide) continue;

    // Only mutate local state when `gh` actually removed the label. If
    // `removeLabel` returns `false` (transient API failure, 403,
    // rate-limit) we leave `entry.labels` alone so the local inbox does
    // not drift from GitHub's truth. The next poll cycle re-reads the
    // live label set and will retry naturally. See issue #364.
    const removed = deps.gh.removeLabel(entry.repo, entry.number, "github-scan:human");
    if (!removed) {
      warnings.push(
        `auto-revert: removeLabel failed for ${entry.repo}#${entry.number}; will retry next cycle`,
      );
      continue;
    }
    entry.labels = entry.labels.filter((l) => l !== "github-scan:human");
    reverted.push(entry.id);
  }

  return { reverted, warnings };
}
