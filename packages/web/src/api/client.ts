const BASE_URL = "/api/v1";
const TOKEN_KEY = "first-tree-hub:tokens";

/**
 * Currently selected organization id, mirrored from
 * `localStorage.selectedOrganizationId` via `setApiSelectedOrganizationId`.
 * Persisted in module scope so the request layer can transparently
 * inject `?organizationId=…` into admin-scoped GET requests without every
 * caller having to thread the value through (decouple-client-from-identity
 * §C / fix for codex P1 #2).
 *
 * Why module scope and not the auth-context: the api wrapper here is
 * import-only — making it depend on a React context would require every
 * caller to live inside the provider tree, which non-component helpers
 * (e.g. `lib/use-agent-name-map`) cannot guarantee.
 */
let selectedOrganizationId: string | null = null;

export function setApiSelectedOrganizationId(value: string | null): void {
  selectedOrganizationId = value;
}

/**
 * Inject the selected organization id into the URL according to the
 * three-class HTTP convention (see `docs/http-path-conventions.md`):
 *
 *   - Class A — `/me/*`, `/auth/*`, `/health*`, `/invitations/*` (public),
 *     `/agent/*` — pass through unchanged.
 *   - Class B — bare resource paths (`/agents`, `/chats`, `/notifications`,
 *     …) — prefixed with `/orgs/:orgId/` automatically.
 *   - Class C — single-resource paths (`/agents/:uuid/...`,
 *     `/chats/:chatId/...`, …) — pass through unchanged; the resource
 *     UUID is org-locating on the server side.
 *
 * Caller paths that already contain `/orgs/:orgId/` are honored as-is so
 * cross-org admin tooling can target a specific org explicitly without
 * the layer second-guessing them.
 */
function decoratePath(path: string): string {
  // Already explicitly scoped — honor.
  if (path.startsWith("/orgs/")) return path;

  // Class A passthroughs.
  if (
    path.startsWith("/me") ||
    path.startsWith("/auth") ||
    path.startsWith("/health") ||
    path.startsWith("/invitations/") ||
    path.startsWith("/agent")
  ) {
    return path;
  }

  // Class C: single-resource paths — UUID/chatId/clientId etc. locates org on server side.
  // Match `/<plural-resource>/<rest>` where the second segment is a non-empty token.
  const classCMatch = /^\/(agents|chats|sessions|tasks|adapters|adapter-mappings|clients|invitations)\/[^/?#]+/.test(
    path,
  );
  if (classCMatch) return path;

  // Class B — needs org prefix.
  if (!selectedOrganizationId) return path; // best-effort: server will 400 cleanly
  return `/orgs/${encodeURIComponent(selectedOrganizationId)}${path}`;
}

type StoredTokens = {
  accessToken: string;
  refreshToken: string;
};

export function getStoredTokens(): StoredTokens | null {
  const raw = localStorage.getItem(TOKEN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

export function setStoredTokens(tokens: StoredTokens): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
}

export function clearStoredTokens(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * One entry from a Zod `issues` array. The server's `setErrorHandler`
 * serializes `ZodError.issues` verbatim under `details` for 400 responses
 * (see `packages/server/src/app.ts`). Keeping the shape as `unknown` here
 * would force every caller to re-narrow; surface the minimal contract
 * instead so form UIs can map `path` → field message without casts.
 */
export type ValidationIssue = {
  path: (string | number)[];
  message: string;
  code?: string;
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Zod validation issues when `status === 400` and the server returned `details`. */
    public readonly issues?: ValidationIssue[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let refreshPromise: Promise<StoredTokens | null> | null = null;

/**
 * Refresh the stored access token via `/auth/refresh`. Reads the current
 * refresh token from `localStorage` and persists the new pair on success.
 *
 * Exposed so non-HTTP transports (the admin WebSocket hook) can drive a
 * refresh on auth failure and recover without waiting for an unrelated HTTP
 * request to coincidentally trip the `request()` 401 path. Concurrent
 * callers share `refreshPromise`, so simultaneous HTTP-401 and WS-4001
 * recoveries fire only one `/auth/refresh` request.
 */
export async function refreshAccessToken(): Promise<StoredTokens | null> {
  const tokens = getStoredTokens();
  if (!tokens?.refreshToken) return null;
  return tryRefresh(tokens.refreshToken);
}

async function tryRefresh(refreshToken: string): Promise<StoredTokens | null> {
  // Deduplicate concurrent refresh attempts
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const res = await fetch(`${BASE_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { accessToken: string; refreshToken?: string };
      // Server refresh only returns accessToken — preserve existing refreshToken
      const updated: StoredTokens = {
        accessToken: body.accessToken,
        refreshToken: body.refreshToken ?? refreshToken,
      };
      setStoredTokens(updated);
      return updated;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function request<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
  const { method = "GET", body } = options ?? {};

  const decoratedPath = decoratePath(path);
  const doFetch = (token?: string) => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(`${BASE_URL}${decoratedPath}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  const tokens = getStoredTokens();
  let res = await doFetch(tokens?.accessToken);

  // Attempt token refresh on 401
  if (res.status === 401 && tokens?.refreshToken) {
    const refreshed = await tryRefresh(tokens.refreshToken);
    if (refreshed) {
      res = await doFetch(refreshed.accessToken);
    }
  }

  if (!res.ok) {
    if (res.status === 401) {
      clearStoredTokens();
      window.dispatchEvent(new CustomEvent("auth:logout"));
    }
    const text = await res.text();
    let message: string;
    let issues: ValidationIssue[] | undefined;
    try {
      const json = JSON.parse(text) as { error?: string; details?: unknown };
      message = json.error ?? text;
      if (Array.isArray(json.details)) {
        issues = json.details.filter(
          (d): d is ValidationIssue =>
            typeof d === "object" && d !== null && Array.isArray((d as { path?: unknown }).path),
        );
      }
    } catch {
      message = text;
    }
    throw new ApiError(res.status, message, issues);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
