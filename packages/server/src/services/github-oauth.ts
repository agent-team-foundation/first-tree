import { GITHUB_API_BASE } from "./github-api-base.js";

/**
 * Direct GitHub API helpers — what used to be the legacy-OAuth client
 * module, now trimmed to just the bits still needed after the App
 * cutover. Specifically:
 *
 *   - `listUserRepos` — proxies `GET /user/repos` for the Step 2 repo
 *     picker. Reads the access token persisted on `auth_identities.metadata`
 *     (legacy OAuth or App user-to-server — same Bearer semantics on the
 *     GitHub side, the picker doesn't care which kind it is).
 *
 *   - `GithubApiError` — thrown on non-2xx from the picker. The route
 *     layer maps it to 401 / 403 / 502 etc. for the frontend.
 *
 * The legacy OAuth flow helpers (`buildAuthorizeUrl`,
 * `exchangeCodeForProfile`) were removed in the D3 cutover (this file no
 * longer participates in sign-in). The App-flavoured equivalents live in
 * `services/github-app.ts`.
 */

/** Minimal repo descriptor returned by `GET /user/repos`. */
export type GithubRepo = {
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
  private: boolean;
  defaultBranch: string | null;
  pushedAt: string | null;
};

export type GithubCreatedRepo = {
  name: string;
  fullName: string;
  ownerLogin: string;
  cloneUrl: string;
  htmlUrl: string;
  private: boolean;
  defaultBranch: string | null;
};

/**
 * Thrown when GitHub's API returns a non-2xx for a token-scoped call.
 * Carries the HTTP status so callers can distinguish auth failures (401 /
 * 403 — typically a stale token or a missing scope) from transient upstream
 * errors.
 */
export class GithubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

/**
 * Fetch the authenticated user's accessible repositories. Used by the
 * Step 2 repo picker. Walks paginated GitHub API responses up to the cap.
 *
 * Takes a Bearer-style access token — works the same way whether that
 * token is a legacy OAuth grant (single-scope `repo`) or an App
 * user-to-server token (scope is whatever the App declared on its
 * settings page). The picker has no business distinguishing them.
 */
export async function listUserRepos(
  accessToken: string,
  opts: { fetcher?: typeof fetch; perPage?: number; maxPages?: number } = {},
): Promise<GithubRepo[]> {
  const fetcher = opts.fetcher ?? fetch;
  const perPage = opts.perPage ?? 100;
  const maxPages = opts.maxPages ?? 3;
  const out: GithubRepo[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${GITHUB_API_BASE}/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=${perPage}&page=${page}`;
    const res = await fetcher(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      throw new GithubApiError(res.status, `GitHub repo list failed (${res.status})`);
    }
    const rows = (await res.json()) as Array<{
      full_name: string;
      clone_url: string;
      html_url: string;
      private: boolean;
      default_branch?: string | null;
      pushed_at?: string | null;
    }>;
    for (const r of rows) {
      out.push({
        fullName: r.full_name,
        cloneUrl: r.clone_url,
        htmlUrl: r.html_url,
        private: r.private,
        defaultBranch: r.default_branch ?? null,
        pushedAt: r.pushed_at ?? null,
      });
    }
    if (rows.length < perPage) break;
  }
  return out;
}

export async function createUserRepo(
  accessToken: string,
  input: { name: string; description?: string; private: boolean },
  opts: { fetcher?: typeof fetch } = {},
): Promise<GithubCreatedRepo> {
  const fetcher = opts.fetcher ?? fetch;
  const payload: Record<string, unknown> = {
    name: input.name,
    private: input.private,
    auto_init: false,
  };
  if (input.description) payload.description = input.description;

  const res = await fetcher(`${GITHUB_API_BASE}/user/repos`, {
    method: "POST",
    headers: githubJsonHeaders(accessToken),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new GithubApiError(res.status, `GitHub repo create failed (${res.status})`);
  }
  return parseCreatedRepo(await res.json());
}

export async function createRepoFile(
  accessToken: string,
  input: { owner: string; repo: string; path: string; branch: string; message: string; contentBase64: string },
  opts: { fetcher?: typeof fetch } = {},
): Promise<void> {
  const fetcher = opts.fetcher ?? fetch;
  const path = encodePath(input.path);
  const res = await fetcher(
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${path}`,
    {
      method: "PUT",
      headers: githubJsonHeaders(accessToken),
      body: JSON.stringify({
        message: input.message,
        content: input.contentBase64,
        branch: input.branch,
      }),
    },
  );
  if (!res.ok) {
    throw new GithubApiError(res.status, `GitHub file create failed (${res.status})`);
  }
}

function githubJsonHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function parseCreatedRepo(body: unknown): GithubCreatedRepo {
  if (!isRecord(body)) {
    throw new GithubApiError(502, "GitHub repo create returned an invalid response");
  }
  const owner = isRecord(body.owner) ? readString(body.owner, "login") : null;
  const name = readString(body, "name");
  const fullName = readString(body, "full_name");
  const cloneUrl = readString(body, "clone_url");
  const htmlUrl = readString(body, "html_url");
  const isPrivate = readBoolean(body, "private");
  if (!owner || !name || !fullName || !cloneUrl || !htmlUrl || isPrivate === null) {
    throw new GithubApiError(502, "GitHub repo create returned an invalid response");
  }
  return {
    name,
    fullName,
    ownerLogin: owner,
    cloneUrl,
    htmlUrl,
    private: isPrivate,
    defaultBranch: readString(body, "default_branch"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

function encodePath(path: string): string {
  return path
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
}
