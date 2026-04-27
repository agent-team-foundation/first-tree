import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signOauthState } from "../services/auth-github.js";
import { createTestApp } from "./helpers.js";

/**
 * Smoke tests for the two endpoints the SaaS wizard's Connect screen
 * polls / calls. Both already existed before PR #4; this file pins
 * the contract so a future change to /clients filtering or
 * /connect-tokens shape doesn't silently break the Connect wizard.
 *
 * The wizard sequence under test:
 *   1. Sign in (dev OAuth) → no membership → user-only token
 *   2. Create workspace → per-org token
 *   3. POST /connect-tokens → returns { token, expiresIn, command }
 *   4. GET /clients → returns the user's clients (empty until first
 *      `first-tree-hub connect` lands a row)
 */
describe("Wizard Connect — server contract", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Re-uses the dev-callback flow from saas-onboarding-auth.test to seed a per-org user. */
  async function devSignIn(opts: { githubId: string; login: string }) {
    const { state } = await signOauthState(app.config.secrets.jwtSecret, "/");
    const params = new URLSearchParams({
      state,
      login: opts.login,
      github_id: opts.githubId,
      email: `${opts.login}@example.local`,
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/dev-callback?${params.toString()}`,
    });
    if (res.statusCode !== 302) throw new Error(`dev sign-in failed: ${res.body}`);
    const loc = res.headers.location ?? "";
    const fragment = new URLSearchParams(loc.slice(loc.indexOf("#") + 1));
    return {
      accessToken: fragment.get("access") ?? "",
      refreshToken: fragment.get("refresh") ?? "",
    };
  }

  async function createWorkspace(token: string, slug: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/workspaces/",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: slug, displayName: `WS ${slug}` },
    });
    if (res.statusCode !== 200) throw new Error(`create failed: ${res.body}`);
    return res.json<{ accessToken: string; refreshToken: string; workspace: { organizationId: string } }>();
  }

  it("POST /connect-tokens returns a JWT + expiresIn + a copy-pasteable CLI command", async () => {
    const id = `${Date.now()}c1`;
    const signIn = await devSignIn({ githubId: id, login: `connect-${id}` });
    const ws = await createWorkspace(signIn.accessToken, `ws-${id}`);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/connect-tokens",
      headers: { authorization: `Bearer ${ws.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ token: string; expiresIn: number; command: string }>();
    expect(body.token).toMatch(/^eyJ/);
    // 10-minute connect-token TTL hard-coded in services/auth.ts. The
    // wizard's "Token expires in 10 minutes" copy depends on this.
    expect(body.expiresIn).toBe(600);
    // The command is what the wizard renders verbatim — confirm shape
    // so a server-side accidental refactor (e.g. dropping the host
    // segment) gets caught here, not by a user pasting `first-tree-hub
    // connect undefined` into their terminal.
    expect(body.command).toMatch(/^first-tree-hub client connect https?:\/\/.+ --token /);
    expect(body.command).toContain(body.token);
  });

  it("POST /connect-tokens uses `server.publicUrl` when set (proxy-safe)", async () => {
    // Inject the config field on the running app — the test framework
    // doesn't let us re-`createTestApp` cheaply per-case. The handler
    // reads `app.config.server.publicUrl` at request time so this works.
    const original = app.config.server.publicUrl;
    (app.config.server as { publicUrl?: string }).publicUrl = "https://hub.example.com";
    try {
      const id = `${Date.now()}c4`;
      const signIn = await devSignIn({ githubId: id, login: `proxy-${id}` });
      const ws = await createWorkspace(signIn.accessToken, `ws-proxy-${id}`);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/connect-tokens",
        headers: { authorization: `Bearer ${ws.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ command: string }>();
      // Configured URL wins over the request's `host` header (which would
      // be 127.0.0.1:<random> for the test inject).
      expect(body.command).toContain("https://hub.example.com");
      expect(body.command).not.toContain("127.0.0.1");
    } finally {
      (app.config.server as { publicUrl?: string }).publicUrl = original;
    }
  });

  it("POST /connect-tokens refuses a rootless user-token (no workspace yet)", async () => {
    // Wizard never reaches Connect with a rootless token — RequireWorkspace
    // bounces them to /setup first. Pin the server-side guard so a
    // misconfigured frontend doesn't accidentally surface a useless
    // command.
    const id = `${Date.now()}c2`;
    const signIn = await devSignIn({ githubId: id, login: `rootless-${id}` });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/connect-tokens",
      headers: { authorization: `Bearer ${signIn.accessToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /clients returns an empty list for a freshly-created workspace", async () => {
    // Wizard's polling loop sees this exact shape: an empty array until
    // the user runs the `first-tree-hub connect` command on their box,
    // at which point the `clients` row materialises and `status==='connected'`.
    const id = `${Date.now()}c3`;
    const signIn = await devSignIn({ githubId: id, login: `empty-${id}` });
    const ws = await createWorkspace(signIn.accessToken, `ws-empty-${id}`);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/clients/",
      headers: { authorization: `Bearer ${ws.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json<unknown[]>();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(0);
  });
});
