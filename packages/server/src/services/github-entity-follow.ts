import type {
  ChatGithubEntity,
  ChatGithubEntityListResponse,
  DeclaredBoundVia,
  GithubEntityBoundVia,
  GithubEntityLiveState,
  GithubEntityType,
} from "@first-tree/shared";
import { githubEntityBoundViaSchema } from "@first-tree/shared";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { chats } from "../db/schema/chats.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { BadRequestError, NotFoundError, ServiceUnavailableError, UnprocessableError } from "../errors.js";
import { createLogger } from "../observability/index.js";
import { GITHUB_API_BASE } from "./github-api-base.js";
import type { GithubAppCredentials } from "./github-app.js";
import { findInstallationByOrg } from "./github-app-installations.js";
import { mintContextTreeInstallationToken } from "./github-app-token.js";
import { insertMappingIfAbsent } from "./github-entity-chat.js";
import { githubEntityDedupKey, githubEntityKeyCandidates, legacyDiscussionEntityKey } from "./github-entity-key.js";
import { materializeChatGithubEntity } from "./github-entity-live.js";
import { type EntityState, setEntityTitle } from "./github-entity-state.js";
import { executeScmFollowLine } from "./scm-attention-line.js";

const log = createLogger("GithubEntityFollow");

/**
 * Explicit follow / unfollow of a GitHub entity — the ONLY agent-side wiring
 * path into `github_entity_chat_mappings`. Creating a PR or Issue never
 * follows it; the session-event auto-binder that used to do so was removed
 * together with the introduction of this service (one entrance, no implicit
 * paths).
 *
 * Design invariants (see the follow/unfollow design doc):
 *   - follow is fail-fast: the entity is resolved against the GitHub API
 *     (existence + canonical `full_name` + issue/PR discrimination + state)
 *     BEFORE any row is written. GitHub being unreachable → 503, never a
 *     blind write — a ghost row that can never route is worse than asking
 *     the caller to retry.
 *   - entity keys are canonicalised to GitHub's `full_name` casing so the
 *     written key always matches the webhook payload's key. (R8)
 *   - unfollow never touches the GitHub API and is fully idempotent: it
 *     deletes every mapping row pointing at the chat for the entity,
 *     whatever pair wrote it, and reports the count. (R4 / R10)
 *   - all races converge on the table's primary key; the loser gets a
 *     deterministic, explainable outcome. (R2 / R6)
 */

const GITHUB_FETCH_TIMEOUT_MS = 5_000;

// Accepted `entity` argument shapes. URL forms are preferred (the caller
// usually has one); short forms match the stored entity-key syntax.
const URL_NUMERIC_RE =
  /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/(pull|issues|discussions)\/(\d+)(?:[/?#].*)?$/;
const URL_COMMIT_RE =
  /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/commit\/([0-9a-fA-F]{6,40})(?:[/?#].*)?$/;
const SHORT_NUMERIC_RE = /^([^/\s]+)\/([^/\s#@]+)#(\d+)$/;
const SHORT_COMMIT_RE = /^([^/\s]+)\/([^/\s#@]+)@([0-9a-fA-F]{6,40})$/;

const URL_PATH_TYPE: Record<string, GithubEntityType> = {
  pull: "pull_request",
  issues: "issue",
  discussions: "discussion",
};

export type EntityReference =
  | {
      kind: "numeric";
      owner: string;
      repo: string;
      number: number;
      /** Explicit type from a URL path; null for the short `owner/repo#N` form. */
      explicitType: Exclude<GithubEntityType, "commit"> | null;
    }
  | { kind: "commit"; owner: string; repo: string; sha: string };

/** Parse the raw `entity` argument. Returns null when no shape matches. */
export function parseEntityReference(raw: string): EntityReference | null {
  const trimmed = raw.trim();

  const urlNumeric = URL_NUMERIC_RE.exec(trimmed);
  if (urlNumeric) {
    const [, owner, repo, path, numberStr] = urlNumeric;
    if (!owner || !repo || !path || !numberStr) return null;
    const explicitType = URL_PATH_TYPE[path];
    if (!explicitType || explicitType === "commit") return null;
    return { kind: "numeric", owner, repo, number: Number(numberStr), explicitType };
  }

  const urlCommit = URL_COMMIT_RE.exec(trimmed);
  if (urlCommit) {
    const [, owner, repo, sha] = urlCommit;
    if (!owner || !repo || !sha) return null;
    return { kind: "commit", owner, repo, sha: sha.toLowerCase() };
  }

  const shortNumeric = SHORT_NUMERIC_RE.exec(trimmed);
  if (shortNumeric) {
    const [, owner, repo, numberStr] = shortNumeric;
    if (!owner || !repo || !numberStr) return null;
    return { kind: "numeric", owner, repo, number: Number(numberStr), explicitType: null };
  }

  const shortCommit = SHORT_COMMIT_RE.exec(trimmed);
  if (shortCommit) {
    const [, owner, repo, sha] = shortCommit;
    if (!owner || !repo || !sha) return null;
    return { kind: "commit", owner, repo, sha: sha.toLowerCase() };
  }

  return null;
}

/**
 * Parse or reject with the canonical usage hint — shared by follow and
 * unfollow so the teaching text (the de-facto docs for agents) has exactly
 * one copy.
 */
function parseEntityReferenceOrThrow(raw: string): EntityReference {
  const ref = parseEntityReference(raw);
  if (!ref) {
    throw new BadRequestError(
      `Unrecognized entity reference "${raw}". Pass a GitHub URL ` +
        `(https://github.com/owner/repo/pull/42), "owner/repo#42", or "owner/repo@<sha>".`,
    );
  }
  return ref;
}

/**
 * Escape SQL LIKE metacharacters (`\`, `%`, `_`) in a literal that will be
 * embedded in a LIKE pattern. GitHub repo names legitimately contain `_`,
 * which LIKE would otherwise treat as match-any-one-char and over-delete
 * across sibling repos.
 */
function escapeLikeLiteral(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

type ResolvedEntity = {
  entityType: GithubEntityType;
  /** Canonical key — GitHub's `full_name` casing, full commit sha. */
  entityKey: string;
  htmlUrl: string;
  title: string | null;
  liveState: GithubEntityLiveState | null;
  entityState: EntityState;
  /** Issue / PR / Discussion number; null for commits. Set where `entityKey` is built. */
  number: number | null;
};

type ResolveOutcome =
  | { ok: true; entity: ResolvedEntity }
  | { ok: false; reason: "repo-not-accessible" | "entity-not-found" | "github-unavailable" };

type GhResponse =
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "not-found" }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

async function ghGet(path: string, token: string, fetcher: typeof fetch): Promise<GhResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetcher(`${GITHUB_API_BASE}${path}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });
    if (res.ok) {
      const body: unknown = await res.json();
      if (typeof body !== "object" || body === null) return { kind: "unavailable" };
      return { kind: "ok", body: body as Record<string, unknown> };
    }
    // 403 from a rate limiter is a transient upstream condition, not an
    // access verdict — surface it as retry-later. Primary rate limits set
    // x-ratelimit-remaining: 0; secondary/abuse limits keep a nonzero
    // budget but carry a retry-after header.
    if (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.get("retry-after"))) {
      return { kind: "unavailable" };
    }
    if (res.status === 404 || res.status === 410) return { kind: "not-found" };
    if (res.status === 401 || res.status === 403) return { kind: "forbidden" };
    // 5xx and anything unexpected → transient.
    return { kind: "unavailable" };
  } catch {
    // Network errors and AbortController timeouts collapse to "unavailable".
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

function readStr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Resolve the reference against the GitHub API: existence, canonical
 * `full_name`, issue-vs-PR discrimination for the short numeric form, and
 * the current lifecycle state.
 *
 * The repo is fetched first so "repo not covered by the installation" (422
 * territory) is distinguishable from "entity number doesn't exist" (404
 * territory) — the installation token only sees repos the App was granted.
 */
async function resolveEntityOnGithub(
  ref: EntityReference,
  token: string,
  fetcher: typeof fetch,
): Promise<ResolveOutcome> {
  const repoRes = await ghGet(`/repos/${ref.owner}/${ref.repo}`, token, fetcher);
  if (repoRes.kind === "unavailable") return { ok: false, reason: "github-unavailable" };
  if (repoRes.kind === "not-found" || repoRes.kind === "forbidden") {
    return { ok: false, reason: "repo-not-accessible" };
  }
  // Canonical casing (and current name after a rename — the API follows the
  // redirect) so the written key always matches webhook-side keys. (R8)
  const fullName = readStr(repoRes.body.full_name) ?? `${ref.owner}/${ref.repo}`;

  if (ref.kind === "commit") {
    const res = await ghGet(`/repos/${fullName}/commits/${ref.sha}`, token, fetcher);
    if (res.kind === "unavailable") return { ok: false, reason: "github-unavailable" };
    if (res.kind !== "ok") return { ok: false, reason: "entity-not-found" };
    const fullSha = readStr(res.body.sha) ?? ref.sha;
    const commit =
      typeof res.body.commit === "object" && res.body.commit !== null
        ? (res.body.commit as Record<string, unknown>)
        : null;
    const message = readStr(commit?.message);
    return {
      ok: true,
      entity: {
        entityType: "commit",
        entityKey: `${fullName}@${fullSha}`,
        htmlUrl: readStr(res.body.html_url) ?? `https://github.com/${fullName}/commit/${fullSha}`,
        title: message ? (message.split("\n", 1)[0]?.trim() ?? null) : null,
        liveState: null,
        entityState: "open",
        number: null,
      },
    };
  }

  if (ref.explicitType === "discussion") {
    return resolveDiscussion(fullName, ref.number, token, fetcher);
  }

  // Issues endpoint covers both issues and PRs (a PR payload carries a
  // `pull_request` block) — one call discriminates the short numeric form
  // and auto-corrects a `/pull/` URL that actually points at an issue.
  const res = await ghGet(`/repos/${fullName}/issues/${ref.number}`, token, fetcher);
  if (res.kind === "unavailable") return { ok: false, reason: "github-unavailable" };
  if (res.kind !== "ok") {
    // Discussions have their own numbering space; a short `#N` that misses
    // issues/PRs may still be a discussion.
    if (ref.explicitType === null) {
      return resolveDiscussion(fullName, ref.number, token, fetcher);
    }
    return { ok: false, reason: "entity-not-found" };
  }

  const prInfo =
    typeof res.body.pull_request === "object" && res.body.pull_request !== null
      ? (res.body.pull_request as Record<string, unknown>)
      : null;
  const number = typeof res.body.number === "number" ? res.body.number : ref.number;
  const rawState = readStr(res.body.state);
  const title = readStr(res.body.title);
  const htmlUrl = readStr(res.body.html_url);

  if (prInfo) {
    const pullRes = await ghGet(`/repos/${fullName}/pulls/${number}`, token, fetcher);
    if (pullRes.kind === "unavailable") return { ok: false, reason: "github-unavailable" };
    if (pullRes.kind === "forbidden") return { ok: false, reason: "repo-not-accessible" };
    if (pullRes.kind !== "ok") return { ok: false, reason: "entity-not-found" };
    const pullState = readStr(pullRes.body.state) ?? rawState;
    const merged = pullRes.body.merged === true || readStr(pullRes.body.merged_at) !== null;
    const draft = pullRes.body.draft === true;
    const entityState: EntityState = merged ? "merged" : pullState === "closed" ? "closed" : draft ? "draft" : "open";
    const liveState: GithubEntityLiveState | null = merged
      ? "merged"
      : draft && pullState === "open"
        ? "draft"
        : pullState === "open" || pullState === "closed"
          ? pullState
          : null;
    return {
      ok: true,
      entity: {
        entityType: "pull_request",
        entityKey: `${fullName}#${number}`,
        htmlUrl: readStr(pullRes.body.html_url) ?? htmlUrl ?? `https://github.com/${fullName}/pull/${number}`,
        title: readStr(pullRes.body.title) ?? title,
        liveState,
        entityState,
        number,
      },
    };
  }

  const entityState: EntityState = rawState === "closed" ? "closed" : "open";
  return {
    ok: true,
    entity: {
      entityType: "issue",
      entityKey: `${fullName}#${number}`,
      htmlUrl: htmlUrl ?? `https://github.com/${fullName}/issues/${number}`,
      title,
      liveState: rawState === "open" || rawState === "closed" ? rawState : null,
      entityState,
      number,
    },
  };
}

async function resolveDiscussion(
  fullName: string,
  number: number,
  token: string,
  fetcher: typeof fetch,
): Promise<ResolveOutcome> {
  const res = await ghGet(`/repos/${fullName}/discussions/${number}`, token, fetcher);
  if (res.kind === "unavailable") return { ok: false, reason: "github-unavailable" };
  if (res.kind !== "ok") return { ok: false, reason: "entity-not-found" };
  const rawState = readStr(res.body.state);
  return {
    ok: true,
    entity: {
      entityType: "discussion",
      entityKey: `${fullName}#${number}`,
      htmlUrl: readStr(res.body.html_url) ?? `https://github.com/${fullName}/discussions/${number}`,
      title: readStr(res.body.title),
      liveState: rawState === "open" || rawState === "closed" ? rawState : null,
      entityState: rawState === "closed" ? "closed" : "open",
      number,
    },
  };
}

export type FollowDeps = {
  appCredentials: GithubAppCredentials | undefined;
  /** Test seam — injected fetch for GitHub API calls AND token minting. */
  fetcher?: typeof fetch;
};

export type DeclareFollowParams = {
  chatId: string;
  organizationId: string;
  humanAgentId: string;
  delegateAgentId: string;
  boundVia: DeclaredBoundVia;
  /** Raw entity reference — URL, `owner/repo#N`, or `owner/repo@sha`. */
  entity: string;
  rebind: boolean;
};

export type DeclareFollowResult =
  | { outcome: "created" | "already_following" | "rebound"; entity: ChatGithubEntity }
  | { outcome: "conflict"; conflict: { chatId: string; topic: string | null } };

/**
 * Follow: wire the entity's event stream into the chat by writing one
 * mapping row under the caller's (human, delegate) pair.
 *
 * Outcome map (the route layer translates to HTTP):
 *   created / rebound   → 201
 *   already_following   → 200 (idempotent re-follow)
 *   conflict            → 409 + existing chat info (`rebind` not set)
 * Thrown:
 *   BadRequestError         → unparseable entity reference
 *   UnprocessableError      → no App installation / repo not covered
 *   NotFoundError           → entity does not exist on GitHub
 *   ServiceUnavailableError → GitHub unreachable; nothing was written
 */
export async function declareEntityFollow(
  db: Database,
  deps: FollowDeps,
  params: DeclareFollowParams,
): Promise<DeclareFollowResult> {
  const ref = parseEntityReferenceOrThrow(params.entity);

  const fetcher = deps.fetcher ?? fetch;
  const installation = await findInstallationByOrg(db, params.organizationId);
  const mint = await mintContextTreeInstallationToken(installation, deps.appCredentials, { fetcher });
  if (!mint.ok) {
    if (mint.reason === "mint-failed") {
      throw new ServiceUnavailableError(
        "GitHub did not issue an installation token — likely a transient upstream failure. The follow was NOT recorded; retry later.",
        { "github.mint_reason": mint.reason },
      );
    }
    throw new UnprocessableError(
      "Following requires the org's GitHub App installation to deliver webhooks, and none is available " +
        `(${mint.reason}). Install the First Tree GitHub App from Team Settings — an operator action.`,
      { "github.mint_reason": mint.reason },
    );
  }

  const resolved = await resolveEntityOnGithub(ref, mint.token, fetcher);
  if (!resolved.ok) {
    if (resolved.reason === "github-unavailable") {
      throw new ServiceUnavailableError("GitHub is temporarily unreachable. The follow was NOT recorded; retry later.");
    }
    if (resolved.reason === "repo-not-accessible") {
      throw new UnprocessableError(
        `The GitHub App installation cannot see ${ref.owner}/${ref.repo} — either the repo does not exist or ` +
          "the installation was not granted access to it. Granting access is an operator action on GitHub.",
      );
    }
    throw new NotFoundError(`Entity not found on GitHub: ${params.entity}. Re-check the reference; do not retry.`);
  }

  const entity = resolved.entity;
  const wireEntity: ChatGithubEntity = {
    entityType: entity.entityType,
    entityKey: entity.entityKey,
    boundVia: params.boundVia,
    htmlUrl: entity.htmlUrl,
    title: entity.title,
    state: entity.liveState,
    number: entity.number,
  };

  type GithubFollowLine = { chatId: string; boundVia: GithubEntityBoundVia; entityKey: string };
  const entityKeyCandidates = githubEntityKeyCandidates(entity.entityType, entity.entityKey);
  const listLines = async (): Promise<GithubFollowLine[]> => {
    const rows = await db
      .select({
        chatId: githubEntityChatMappings.chatId,
        boundVia: githubEntityChatMappings.boundVia,
        entityKey: githubEntityChatMappings.entityKey,
      })
      .from(githubEntityChatMappings)
      .where(
        and(
          eq(githubEntityChatMappings.organizationId, params.organizationId),
          eq(githubEntityChatMappings.humanAgentId, params.humanAgentId),
          eq(githubEntityChatMappings.delegateAgentId, params.delegateAgentId),
          eq(githubEntityChatMappings.entityType, entity.entityType),
          inArray(githubEntityChatMappings.entityKey, entityKeyCandidates),
        ),
      )
      .orderBy(
        desc(sql`${githubEntityChatMappings.entityKey} = ${entity.entityKey}`),
        asc(githubEntityChatMappings.boundAt),
      );
    return rows.map((row) => {
      const parsed = githubEntityBoundViaSchema.safeParse(row.boundVia);
      return {
        chatId: row.chatId,
        boundVia: parsed.success ? parsed.data : "direct",
        entityKey: row.entityKey,
      };
    });
  };

  // Refresh an existing row before the shared state machine moves it. A
  // vanished-row fallback insert seeds the same title through createLine.
  if (entity.title && entity.title.length > 0) {
    await setEntityTitle(db, {
      organizationId: params.organizationId,
      entityType: entity.entityType,
      entityKey: entityKeyCandidates,
      title: entity.title,
    });
  }

  const result = await executeScmFollowLine({
    targetChatId: params.chatId,
    rebind: params.rebind,
    storage: {
      listLines,
      removeLines: async (rows) => {
        const keys = rows.map((row) => row.entityKey);
        if (keys.length === 0) return;
        await db
          .delete(githubEntityChatMappings)
          .where(
            and(
              eq(githubEntityChatMappings.organizationId, params.organizationId),
              eq(githubEntityChatMappings.humanAgentId, params.humanAgentId),
              eq(githubEntityChatMappings.delegateAgentId, params.delegateAgentId),
              eq(githubEntityChatMappings.entityType, entity.entityType),
              inArray(githubEntityChatMappings.entityKey, keys),
            ),
          );
      },
      getChatTopic: async (chatId) => {
        const [chat] = await db.select({ topic: chats.topic }).from(chats).where(eq(chats.id, chatId)).limit(1);
        return chat?.topic ?? null;
      },
      moveLine: async (row) => {
        const [moved] = await db
          .update(githubEntityChatMappings)
          .set({
            chatId: params.chatId,
            boundVia: params.boundVia,
            entityState: entity.entityState,
            boundAt: new Date(),
          })
          .where(
            and(
              eq(githubEntityChatMappings.organizationId, params.organizationId),
              eq(githubEntityChatMappings.humanAgentId, params.humanAgentId),
              eq(githubEntityChatMappings.delegateAgentId, params.delegateAgentId),
              eq(githubEntityChatMappings.entityType, entity.entityType),
              eq(githubEntityChatMappings.entityKey, row.entityKey),
            ),
          )
          .returning({
            chatId: githubEntityChatMappings.chatId,
            boundVia: githubEntityChatMappings.boundVia,
            entityKey: githubEntityChatMappings.entityKey,
          });
        return moved ? { ...moved, boundVia: params.boundVia } : null;
      },
      createLine: async () => {
        const inserted = await insertMappingIfAbsent(db, {
          organizationId: params.organizationId,
          humanAgentId: params.humanAgentId,
          delegateAgentId: params.delegateAgentId,
          entity: {
            type: entity.entityType,
            key: entity.entityKey,
            url: entity.htmlUrl,
            title: entity.title ?? undefined,
          },
          chatId: params.chatId,
          boundVia: params.boundVia,
          entityState: entity.entityState,
        });
        const lines = await listLines();
        const record = lines.find((line) => line.chatId === inserted.chatId) ?? lines[0];
        if (!record) throw new Error("GitHub follow insert completed without a surviving mapping");
        return { record, inserted: inserted.inserted };
      },
    },
  });

  if (result.outcome === "conflict") return result;
  if (result.outcome === "created") {
    log.info(
      { chatId: params.chatId, entityKey: entity.entityKey, boundVia: params.boundVia },
      "github follow recorded",
    );
  } else if (result.outcome === "rebound") {
    log.info({ toChatId: params.chatId, entityKey: entity.entityKey }, "github follow rebound");
  }
  return {
    outcome: result.outcome,
    entity: {
      ...wireEntity,
      ...(result.outcome === "already_following" ? { boundVia: result.record.boundVia } : {}),
    },
  };
}

/**
 * Unfollow: explicit stop-tracking for this chat. Deletes EVERY mapping row
 * pointing at this chat for the entity — whatever pair or `bound_via` wrote
 * it (R10) — and reports the count. Never touches the GitHub API; always
 * succeeds (R4: `removed: 0` is terminal success).
 *
 * Matching is case-insensitive on the key (GitHub repo slugs are
 * case-insensitive) and prefix-based for commit shas so a short sha
 * unfollows the full-sha row. A repo renamed since the row was written
 * cannot be matched without the API — that is the known whole-table key
 * drift limitation, out of scope here (R8 note).
 */
export async function removeEntityFollow(
  db: Database,
  params: { chatId: string; entity: string },
): Promise<{ removed: number }> {
  const ref = parseEntityReferenceOrThrow(params.entity);

  const chatCond = eq(githubEntityChatMappings.chatId, params.chatId);
  let removedRows: Array<{ entityKey: string }>;
  if (ref.kind === "commit") {
    // Prefix match so a short sha unfollows the full-sha row; LIKE
    // metacharacters in owner/repo (GitHub allows `_`) are escaped so the
    // pattern can't over-match sibling repos.
    const prefix = escapeLikeLiteral(`${ref.owner}/${ref.repo}@${ref.sha}`.toLowerCase());
    removedRows = await db
      .delete(githubEntityChatMappings)
      .where(
        and(
          chatCond,
          eq(githubEntityChatMappings.entityType, "commit"),
          sql`lower(${githubEntityChatMappings.entityKey}) LIKE ${`${prefix}%`}`,
        ),
      )
      .returning({ entityKey: githubEntityChatMappings.entityKey });
  } else {
    const key = `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
    // Type matching without a GitHub call (unfollow must not depend on
    // GitHub being up):
    //   - Issues and PRs share one numbering space, and follow auto-corrects
    //     a `/pull/N` URL that actually points at an issue (and vice versa)
    //     — so an explicit issue/PR reference matches BOTH types, otherwise
    //     the row created through the auto-corrected follow could never be
    //     removed with the same reference the caller used to create it.
    //   - Discussions number independently; an explicit `/discussions/N`
    //     URL matches only discussions, and only the bare `owner/repo#N`
    //     form sweeps all three ("make this chat quiet about #N").
    const types: GithubEntityType[] =
      ref.explicitType === "discussion"
        ? ["discussion"]
        : ref.explicitType !== null
          ? ["issue", "pull_request"]
          : ["issue", "pull_request", "discussion"];
    const lowerKeys = new Set([key]);
    if (types.includes("discussion")) {
      const legacyKey = legacyDiscussionEntityKey(key);
      if (legacyKey) lowerKeys.add(legacyKey);
    }
    const keyConditions = [...lowerKeys].map(
      (lowerKey) => sql`lower(${githubEntityChatMappings.entityKey}) = ${lowerKey}`,
    );
    removedRows = await db
      .delete(githubEntityChatMappings)
      .where(and(chatCond, inArray(githubEntityChatMappings.entityType, types), or(...keyConditions)))
      .returning({ entityKey: githubEntityChatMappings.entityKey });
  }

  if (removedRows.length > 0) {
    log.info({ chatId: params.chatId, entity: params.entity, removed: removedRows.length }, "github unfollow");
  }
  return { removed: removedRows.length };
}

/**
 * List the entities wired into a chat — shared by the user-scoped sidebar
 * route and the agent-scoped `github following` CLI. Reads only the mapping
 * rows, dedups by entity (the pair axes are an audit detail), and projects
 * lifecycle state from the webhook-synced `entity_state` column. This hot
 * read path deliberately does not mint GitHub tokens or call GitHub.
 */
export async function listChatGithubEntities(
  db: Database,
  params: { chatId: string },
): Promise<ChatGithubEntityListResponse> {
  const rows = await db
    .select({
      entityType: githubEntityChatMappings.entityType,
      entityKey: githubEntityChatMappings.entityKey,
      boundVia: githubEntityChatMappings.boundVia,
      entityState: githubEntityChatMappings.entityState,
      title: githubEntityChatMappings.title,
      boundAt: githubEntityChatMappings.boundAt,
    })
    .from(githubEntityChatMappings)
    .where(eq(githubEntityChatMappings.chatId, params.chatId))
    .orderBy(desc(githubEntityChatMappings.boundAt));

  if (rows.length === 0) return { items: [] };

  const dedup = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = githubEntityDedupKey(r.entityType, r.entityKey);
    // Rows arrive newest-first so the dedup keeps the most recent binding,
    // which carries the `boundVia` the user actually triggered last.
    if (!dedup.has(key)) dedup.set(key, r);
  }

  const items = Array.from(dedup.values()).map((r) => materializeChatGithubEntity(r));
  return { items: items.filter((x): x is NonNullable<typeof x> => x !== null) };
}
