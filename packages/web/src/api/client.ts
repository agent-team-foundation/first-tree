import { BROWSER_STORAGE_SCOPE_INVALIDATED_EVENT } from "../lib/browser-storage-scope.js";

const BASE_URL = "/api/v1";
const TOKEN_KEY = "first-tree:tokens";

/**
 * Currently selected organization id, set by the auth-context after `/me`
 * resolves. Lives in module scope (not React context) so non-React helpers
 * — e.g. `lib/use-agent-name-map`, the admin WS hook — can read it without
 * sitting inside a provider tree.
 *
 * Read only by `withOrg`. Paths that don't go through `withOrg` are sent
 * verbatim and don't depend on this value.
 */
let selectedOrganizationId: string | null = null;

export function setApiSelectedOrganizationId(value: string | null): void {
  selectedOrganizationId = value;
}

/**
 * The currently-selected org id, as the AuthProvider keeps it in sync (mount,
 * /me reconcile, switch, logout). The single source of truth for non-React
 * consumers (e.g. the admin websocket) — read this instead of localStorage,
 * which is now keyed per user and not safe to read by a fixed key.
 */
export function getApiSelectedOrganizationId(): string | null {
  return selectedOrganizationId;
}

/**
 * Window event announcing that the active org selection changed (a user-driven
 * `selectOrganization`). The org-scoped admin WebSocket (`/orgs/:orgId/ws/`)
 * reads `getApiSelectedOrganizationId()` only when it (re)connects and is not
 * re-opened by React state, so `useAdminWs` listens for this to reconnect
 * against the new org — otherwise a team switch keeps streaming the previous
 * org's realtime frames. Dispatched on `window` to stay decoupled, mirroring
 * the existing `auth:logout` signal.
 */
export const ADMIN_WS_ORG_CHANGED_EVENT = "admin-ws:org-changed";

/**
 * Prefix an org-scoped path with `/orgs/<currentOrgId>/`. Use this on every
 * call that targets a resource living inside the user's currently-viewed
 * organization. Paths that aren't org-scoped (`/me/...`, `/auth/...`,
 * `/agents/<uuid>/...`, `/chats/<id>/...`) are written verbatim at the call
 * site and don't go through this helper.
 *
 * Throws if no org is selected. By the time any React Query query fires,
 * the `meLoaded` gate in `RequireAuth` has already let `/me` populate the
 * org id; a throw here therefore signals a real bug (e.g. someone calling
 * `withOrg` outside the auth tree) rather than a transient race. Failing
 * fast is much easier to trace than a silent 404.
 */
export function withOrg(path: string): string {
  if (!selectedOrganizationId) {
    throw new Error(`withOrg("${path}") called before an organization is selected`);
  }
  return `/orgs/${encodeURIComponent(selectedOrganizationId)}${path}`;
}

/**
 * Prefix a path with an explicit `/orgs/<orgId>/` — for tools that target
 * an organization other than the user's currently-viewed one (invite link
 * panel, cross-org admin views). Pure string formatter; doesn't consult
 * the module-scope `selectedOrganizationId`.
 */
export function withOrgAt(orgId: string, path: string): string {
  return `/orgs/${encodeURIComponent(orgId)}${path}`;
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
  authGeneration += 1;
}

export function clearStoredTokens(): void {
  localStorage.removeItem(TOKEN_KEY);
  authGeneration += 1;
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
    /** Machine-readable code from the error body (`{ code }`), when the server sent one. */
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let authGeneration = 0;
let refreshInFlight: { refreshToken: string; generation: number; promise: Promise<StoredTokens | null> } | null = null;

if (typeof window !== "undefined") {
  window.addEventListener(BROWSER_STORAGE_SCOPE_INVALIDATED_EVENT, () => {
    authGeneration += 1;
    refreshInFlight = null;
  });
}

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
  // Deduplicate only callers for the same credential. A new account must not
  // inherit a refresh promise started by the previous account.
  if (refreshInFlight?.refreshToken === refreshToken) return refreshInFlight.promise;
  const generation = authGeneration;
  const promise = (async () => {
    try {
      const res = await fetch(`${BASE_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { accessToken: string; refreshToken?: string };
      // Sliding-window refresh: server returns a fresh refreshToken on every
      // call (services/auth.ts:refreshAccessToken). Fall back to the existing
      // one if the server response somehow omits it — defends against any
      // future change that goes back to access-only refreshes.
      const updated: StoredTokens = {
        accessToken: body.accessToken,
        refreshToken: body.refreshToken ?? refreshToken,
      };
      // Logout/login/adoptTokens may have replaced the credential while the
      // provider request was in flight. Discard the old response before it can
      // repopulate storage or be used for a retry under the new account.
      if (generation !== authGeneration || getStoredTokens()?.refreshToken !== refreshToken) return null;
      setStoredTokens(updated);
      return updated;
    } catch {
      return null;
    } finally {
      if (refreshInFlight?.refreshToken === refreshToken && refreshInFlight.generation === generation) {
        refreshInFlight = null;
      }
    }
  })();
  refreshInFlight = { refreshToken, generation, promise };
  return promise;
}

async function request<T>(
  path: string,
  options?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  const { method = "GET", body, signal } = options ?? {};

  // No path rewriting here — callers prefix org-scoped paths with `withOrg` /
  // `withOrgAt` before passing in; everything else (`/me/...`, `/auth/...`,
  // `/agents/<uuid>/...`, etc.) is sent verbatim. Anonymous endpoints (invite
  // preview, bootstrap probe) bypass this wrapper entirely and call
  // `fetch()` directly without an Authorization header.
  const doFetch = (token?: string) => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  };

  const tokens = getStoredTokens();
  const requestGeneration = authGeneration;
  let responseGeneration = requestGeneration;
  let responseAccessToken = tokens?.accessToken;
  let res = await doFetch(tokens?.accessToken);

  // Attempt token refresh on 401
  if (res.status === 401 && tokens?.refreshToken) {
    const refreshed = await tryRefresh(tokens.refreshToken);
    if (refreshed) {
      if (getStoredTokens()?.accessToken !== refreshed.accessToken) {
        throw new ApiError(401, "Authentication changed while refreshing");
      }
      responseGeneration = authGeneration;
      responseAccessToken = refreshed.accessToken;
      res = await doFetch(refreshed.accessToken);
    } else if (authGeneration !== requestGeneration) {
      throw new ApiError(401, "Authentication changed while refreshing");
    }
  }

  if (!res.ok) {
    if (res.status === 401) {
      const current = getStoredTokens();
      if (authGeneration !== responseGeneration || current?.accessToken !== responseAccessToken) {
        throw new ApiError(401, "Authentication changed while requesting");
      }
      clearStoredTokens();
      window.dispatchEvent(new CustomEvent("auth:logout"));
    }
    const text = await res.text();
    let message: string;
    let issues: ValidationIssue[] | undefined;
    let code: string | undefined;
    try {
      const json = JSON.parse(text) as { error?: string; code?: string; details?: unknown };
      message = json.error ?? text;
      code = typeof json.code === "string" ? json.code : undefined;
      if (Array.isArray(json.details)) {
        issues = json.details.filter(
          (d): d is ValidationIssue =>
            typeof d === "object" && d !== null && Array.isArray((d as { path?: unknown }).path),
        );
      }
    } catch {
      message = text;
    }
    throw new ApiError(res.status, message, issues, code);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Auth-aware fetch for non-JSON payloads — binary upload (octet-stream body)
 * and blob download. Mirrors `request()`'s bearer-token injection and single
 * 401-refresh retry, but never touches the request body or parses the
 * response: the caller owns both. Throws `ApiError` on a non-ok response
 * (after the refresh retry), matching `request()`'s error contract.
 */
export async function apiFetchRaw(
  path: string,
  init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {},
): Promise<Response> {
  const doFetch = (token?: string) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`${BASE_URL}${path}`, { method: init.method ?? "GET", headers, body: init.body });
  };

  const tokens = getStoredTokens();
  const requestGeneration = authGeneration;
  let responseGeneration = requestGeneration;
  let responseAccessToken = tokens?.accessToken;
  let res = await doFetch(tokens?.accessToken);

  if (res.status === 401 && tokens?.refreshToken) {
    const refreshed = await tryRefresh(tokens.refreshToken);
    if (refreshed) {
      if (getStoredTokens()?.accessToken !== refreshed.accessToken) {
        throw new ApiError(401, "Authentication changed while refreshing");
      }
      responseGeneration = authGeneration;
      responseAccessToken = refreshed.accessToken;
      res = await doFetch(refreshed.accessToken);
    } else if (authGeneration !== requestGeneration) {
      throw new ApiError(401, "Authentication changed while refreshing");
    }
  }

  if (!res.ok) {
    if (res.status === 401) {
      const current = getStoredTokens();
      if (authGeneration !== responseGeneration || current?.accessToken !== responseAccessToken) {
        throw new ApiError(401, "Authentication changed while requesting");
      }
      clearStoredTokens();
      window.dispatchEvent(new CustomEvent("auth:logout"));
    }
    const text = await res.text();
    let message = text;
    try {
      const json = JSON.parse(text) as { error?: string };
      message = json.error ?? text;
    } catch {
      // Non-JSON error body — surface the raw text.
    }
    throw new ApiError(res.status, message);
  }

  return res;
}

export const api = {
  get: <T>(path: string, options?: { signal?: AbortSignal }) => request<T>(path, options),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
