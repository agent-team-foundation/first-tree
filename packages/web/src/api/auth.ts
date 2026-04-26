import type { LoginResponse } from "@agent-team-foundation/first-tree-hub-shared";

const BASE_URL = "/api/v1";

export async function login(username: string, password: string): Promise<LoginResponse> {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const text = await res.text();
    let message: string;
    try {
      const json = JSON.parse(text) as { error?: string };
      message = json.error ?? text;
    } catch {
      message = text;
    }
    throw new Error(message);
  }
  return (await res.json()) as LoginResponse;
}

/**
 * Attempt to mint a token pair via the loopback-only local-bootstrap endpoint.
 *
 * Local-mode auth recovery: a fresh localhost browser opens `/login` with no
 * stored tokens. The endpoint is only registered when the server is running
 * in local mode and accessible from loopback — both gates the server
 * enforces. Hosted-mode deployments disable the route (returns 404), and
 * cross-origin attackers fail the request `Host` / IP gates inside the
 * server (returns 401).
 *
 * Returns null on any non-200 so the caller can transparently fall back to
 * username/password without surfacing the gate detail.
 */
export async function localBootstrap(): Promise<LoginResponse | null> {
  try {
    const res = await fetch(`${BASE_URL}/auth/local-bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as LoginResponse;
  } catch {
    return null;
  }
}
