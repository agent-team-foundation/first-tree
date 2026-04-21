const BASE_URL = "/api/v1";
const TOKEN_KEY = "first-tree-hub:tokens";

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

  const doFetch = (token?: string) => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(`${BASE_URL}${path}`, {
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
