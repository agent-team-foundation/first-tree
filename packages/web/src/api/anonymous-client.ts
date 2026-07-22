import { expectedAuthorityHeaders, getPinnedServerAuthority, readBoundedResponseText } from "./server-authority.js";

const BASE_URL = "/api/v1";
const MAX_ANONYMOUS_RESPONSE_BYTES = 64 * 1024;
const MAX_ANONYMOUS_ERROR_BYTES = 4096;

export class AnonymousApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AnonymousApiError";
  }
}

async function anonymousRequest<T>(
  path: string,
  options?: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  const authority = await getPinnedServerAuthority();
  const method = options?.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...expectedAuthorityHeaders(authority),
  };
  if (options?.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    redirect: "error",
    headers,
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options?.signal,
  });
  if (!response.ok) {
    let text = "";
    try {
      text = await readBoundedResponseText(response, MAX_ANONYMOUS_ERROR_BYTES);
    } catch {
      throw new AnonymousApiError(response.status, `Request failed (${response.status})`);
    }
    let message = text || `Request failed (${response.status})`;
    try {
      const body: unknown = JSON.parse(text);
      if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      // Plain-text anonymous error.
    }
    throw new AnonymousApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new AnonymousApiError(502, "Server returned an invalid response");
  }
  try {
    const text = await readBoundedResponseText(response, MAX_ANONYMOUS_RESPONSE_BYTES);
    return JSON.parse(text) as T;
  } catch {
    throw new AnonymousApiError(502, "Server returned an invalid response");
  }
}

export const anonymousApi = {
  get: <T>(path: string, options?: { signal?: AbortSignal }) => anonymousRequest<T>(path, options),
  post: <T>(path: string, body?: unknown, options?: { signal?: AbortSignal }) =>
    anonymousRequest<T>(path, { method: "POST", body, signal: options?.signal }),
};
