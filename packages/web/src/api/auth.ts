import type { LoginResponse } from "@agent-team-foundation/first-tree-hub-shared";

const BASE_URL = "/api/v1";

export async function login(username: string, password: string): Promise<LoginResponse> {
  const res = await fetch(`${BASE_URL}/admin/auth/login`, {
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
