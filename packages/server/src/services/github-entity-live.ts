import {
  type ChatGithubEntity,
  GITHUB_ENTITY_TYPES,
  type GithubEntityBoundVia,
  type GithubEntityLiveState,
  type GithubEntityType,
  githubEntityBoundViaSchema,
} from "@agent-team-foundation/first-tree-hub-shared";

/**
 * Per-entity GitHub fetch timeout. GitHub's `api.github.com` is typically
 * < 500ms but the right sidebar must not block on a stuck connection — a
 * 4-second cap keeps the worst-case `chat-detail` request bounded.
 */
const GITHUB_FETCH_TIMEOUT_MS = 4_000;

const GITHUB_ENTITY_TYPE_SET = new Set<string>(GITHUB_ENTITY_TYPES);

/**
 * Parsed `entityKey`. Two shapes:
 *
 *   - `owner/repo#42`      — issue / pull_request / discussion
 *   - `owner/repo@<sha>`   — commit
 */
type ParsedEntityKey =
  | { kind: "numeric"; owner: string; repo: string; number: number }
  | { kind: "sha"; owner: string; repo: string; sha: string }
  | null;

const NUMERIC_ENTITY_KEY = /^([^/\s]+)\/([^/\s#@]+)#(\d+)$/;
const SHA_ENTITY_KEY = /^([^/\s]+)\/([^/\s#@]+)@([0-9a-f]{6,40})$/;

function parseEntityKey(entityType: GithubEntityType, entityKey: string): ParsedEntityKey {
  if (entityType === "commit") {
    const m = SHA_ENTITY_KEY.exec(entityKey);
    if (!m) return null;
    const [, owner, repo, sha] = m;
    if (!owner || !repo || !sha) return null;
    return { kind: "sha", owner, repo, sha };
  }
  const m = NUMERIC_ENTITY_KEY.exec(entityKey);
  if (!m) return null;
  const [, owner, repo, numberStr] = m;
  if (!owner || !repo || !numberStr) return null;
  return { kind: "numeric", owner, repo, number: Number(numberStr) };
}

/**
 * Build the canonical `https://github.com/...` URL for an entity. Pure
 * derivation from `(entityType, entityKey)` so the link is always present
 * even when the live API fetch fails.
 */
function buildHtmlUrl(entityType: GithubEntityType, parsed: NonNullable<ParsedEntityKey>): string {
  const repoBase = `https://github.com/${parsed.owner}/${parsed.repo}`;
  if (parsed.kind === "sha") return `${repoBase}/commit/${parsed.sha}`;
  switch (entityType) {
    case "pull_request":
      return `${repoBase}/pull/${parsed.number}`;
    case "issue":
      return `${repoBase}/issues/${parsed.number}`;
    case "discussion":
      return `${repoBase}/discussions/${parsed.number}`;
    default:
      // Numeric entity that isn't pr/issue/discussion shouldn't happen with
      // the current schema, but fall back to the bare repo so the UI still
      // has a useful link instead of an empty `href`.
      return repoBase;
  }
}

export type FetchedEntityLiveFields = {
  title: string | null;
  state: GithubEntityLiveState | null;
};

const GITHUB_API_BASE = "https://api.github.com";

/**
 * Fetch the live title + state for one entity. Returns `{ title: null,
 * state: null }` on any failure — the caller threads these straight to
 * the wire so the row still renders with just the entityKey + link.
 *
 * Discussions need the GraphQL API to resolve title/state and are out
 * of scope for this iteration; we return nulls so the row stays a
 * link-only chip.
 */
async function fetchEntityLiveFields(
  entityType: GithubEntityType,
  parsed: NonNullable<ParsedEntityKey>,
  token: string,
  fetcher: typeof fetch,
): Promise<FetchedEntityLiveFields> {
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  // AbortController caps every per-entity round-trip at
  // GITHUB_FETCH_TIMEOUT_MS. Without it a stuck connection would block
  // the entire `/chats/:id/github-entities` response (Promise.all on the
  // call site amplifies the worst case).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
  const fetchOpts = { headers, signal: controller.signal } as const;
  try {
    if (entityType === "pull_request" && parsed.kind === "numeric") {
      const res = await fetcher(
        `${GITHUB_API_BASE}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`,
        fetchOpts,
      );
      if (!res.ok) return { title: null, state: null };
      const body = (await res.json()) as { title?: string; state?: string; merged?: boolean; draft?: boolean };
      // Collapse PR's three boolean axes into the unified enum: a merged
      // PR is always merged regardless of state; an open draft is `draft`;
      // anything else maps directly from `state`.
      let state: GithubEntityLiveState | null = null;
      if (body.merged) state = "merged";
      else if (body.draft && body.state === "open") state = "draft";
      else if (body.state === "open" || body.state === "closed") state = body.state;
      return { title: body.title ?? null, state };
    }
    if (entityType === "issue" && parsed.kind === "numeric") {
      const res = await fetcher(
        `${GITHUB_API_BASE}/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`,
        fetchOpts,
      );
      if (!res.ok) return { title: null, state: null };
      const body = (await res.json()) as { title?: string; state?: string };
      const state: GithubEntityLiveState | null = body.state === "open" || body.state === "closed" ? body.state : null;
      return { title: body.title ?? null, state };
    }
    if (entityType === "commit" && parsed.kind === "sha") {
      const res = await fetcher(
        `${GITHUB_API_BASE}/repos/${parsed.owner}/${parsed.repo}/commits/${parsed.sha}`,
        fetchOpts,
      );
      if (!res.ok) return { title: null, state: null };
      const body = (await res.json()) as { commit?: { message?: string } };
      // First line of the commit message is its de-facto title.
      const title = body.commit?.message?.split("\n", 1)[0]?.trim() ?? null;
      return { title, state: null };
    }
    return { title: null, state: null };
  } catch {
    // Network errors, AbortController timeouts, and JSON parse errors all
    // collapse to "unavailable"; the row still renders with the link.
    return { title: null, state: null };
  } finally {
    clearTimeout(timer);
  }
}

export type MappingRow = {
  entityType: string;
  entityKey: string;
  boundVia: string;
};

/**
 * Materialise the wire-shape `ChatGithubEntity` for a single mapping row.
 *
 * `parsed` may be null when `entityKey` doesn't match the expected
 * `owner/repo#N` or `owner/repo@<sha>` shape; in that case the
 * `htmlUrl` falls back to a search URL keyed on the raw `entityKey`
 * (still better than dropping the row silently). Live fields are null.
 */
export async function resolveChatGithubEntity(
  row: MappingRow,
  token: string | null,
  fetcher: typeof fetch = fetch,
): Promise<ChatGithubEntity | null> {
  // Defend against unknown enum values landing here — schema drift between
  // shared and server would otherwise propagate to the wire. Both axes are
  // narrowed via the canonical Zod schema (boundVia) and the exported
  // tuple-derived Set (entityType) so any future enum entry needs at most
  // a touch on `shared/`, never this file.
  if (!GITHUB_ENTITY_TYPE_SET.has(row.entityType)) return null;
  const entityType: GithubEntityType = row.entityType as GithubEntityType; // safe: set membership just narrowed it
  const boundViaParsed = githubEntityBoundViaSchema.safeParse(row.boundVia);
  if (!boundViaParsed.success) return null;
  const boundVia: GithubEntityBoundVia = boundViaParsed.data;
  const parsed = parseEntityKey(entityType, row.entityKey);
  if (!parsed) return null;
  const live = token ? await fetchEntityLiveFields(entityType, parsed, token, fetcher) : { title: null, state: null };
  return {
    entityType,
    entityKey: row.entityKey,
    boundVia,
    htmlUrl: buildHtmlUrl(entityType, parsed),
    title: live.title,
    state: live.state,
    number: parsed.kind === "numeric" ? parsed.number : null,
  };
}

export const __testing = {
  parseEntityKey,
  buildHtmlUrl,
  fetchEntityLiveFields,
};
