import type { GithubProfile } from "./auth-identity.js";

const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const USER_EMAILS_URL = "https://api.github.com/user/emails";
const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

export type GithubOauthConfig = {
  clientId: string;
  clientSecret: string;
};

/**
 * Build the github.com authorize URL. `redirect_uri` is the server's
 * /callback endpoint; `state` is the signed JWT from oauth-state.ts.
 */
export function buildAuthorizeUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("scope", "read:user user:email repo");
  url.searchParams.set("allow_signup", "true");
  return url.toString();
}

export type ExchangeCodeResult = {
  profile: GithubProfile;
  /**
   * Raw OAuth access token. Callers persist this encrypted on the
   * `auth_identities` row so the Step 2 repo picker can hit GitHub's
   * `/user/repos` endpoint without a second OAuth round-trip.
   */
  accessToken: string;
};

/**
 * Exchange an OAuth code for an access token + fetch the user profile.
 *
 * The default `fetch` is overridable via `opts.fetcher` so tests can mock
 * the GitHub round-trip without standing up a fake server. The contract
 * the test fake must honor:
 *   - First call: POST `${TOKEN_URL}` → returns `{ access_token: string }`
 *   - Then GET `${USER_URL}` with `Authorization: Bearer …`
 *   - Then GET `${USER_EMAILS_URL}` (only if `/user` returned no email)
 */
export async function exchangeCodeForProfile(
  config: GithubOauthConfig,
  code: string,
  redirectUri: string,
  opts: { fetcher?: typeof fetch } = {},
): Promise<ExchangeCodeResult> {
  const fetcher = opts.fetcher ?? fetch;

  const tokenRes = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`GitHub token exchange failed (${tokenRes.status})`);
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenJson.access_token) {
    throw new Error(tokenJson.error ?? "GitHub token exchange returned no access_token");
  }

  const userRes = await fetcher(USER_URL, {
    headers: { Authorization: `Bearer ${tokenJson.access_token}`, Accept: "application/vnd.github+json" },
  });
  if (!userRes.ok) {
    throw new Error(`GitHub user fetch failed (${userRes.status})`);
  }
  const user = (await userRes.json()) as {
    id: number;
    login: string;
    name?: string | null;
    email?: string | null;
    avatar_url?: string | null;
  };

  let email = user.email ?? null;
  if (!email) {
    // The /user endpoint hides email when the user marked it private. The
    // /user/emails endpoint requires the `user:email` scope (which we ask
    // for). We pick the primary verified address, or the first verified.
    const emailsRes = await fetcher(USER_EMAILS_URL, {
      headers: { Authorization: `Bearer ${tokenJson.access_token}`, Accept: "application/vnd.github+json" },
    });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
      const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
      email = primary?.email ?? null;
    }
  }

  return {
    profile: {
      githubId: String(user.id),
      login: user.login,
      email,
      displayName: user.name ?? null,
      avatarUrl: user.avatar_url ?? null,
    },
    accessToken: tokenJson.access_token,
  };
}

/** Minimal repo descriptor returned by `GET /user/repos`. */
export type GithubRepo = {
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
  private: boolean;
  defaultBranch: string | null;
  pushedAt: string | null;
};

/**
 * Fetch the authenticated user's accessible repositories. Used by the
 * Step 2 repo picker. Walks paginated GitHub API responses up to the cap.
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
    const url = `https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=${perPage}&page=${page}`;
    const res = await fetcher(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      throw new Error(`GitHub repo list failed (${res.status})`);
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
