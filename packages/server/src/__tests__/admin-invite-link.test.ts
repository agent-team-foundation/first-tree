import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signOauthState } from "../services/auth-github.js";
import { createTestApp } from "./helpers.js";

/**
 * Server contract for the /admin invite-link panel surface (M6 / P0-2):
 * `/me` returns `workspace.inviteUrl` for admins, `null` for members.
 * The link itself uses `server.publicUrl` when configured (proxy-safe)
 * and falls back to the request's host header otherwise.
 */
describe("Admin invite link — surfaced via /me workspace.inviteUrl", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app?.close();
  });

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
    return { accessToken: fragment.get("access") ?? "" };
  }

  it("admin sees the workspace invite URL; members see null", async () => {
    // Admin path: workspace creator is auto-admin.
    const id = `${Date.now()}il1`;
    const adminSignIn = await devSignIn({ githubId: id, login: `admin-${id}` });
    const ws = await app.inject({
      method: "POST",
      url: "/api/v1/me/workspaces/",
      headers: { authorization: `Bearer ${adminSignIn.accessToken}` },
      payload: { name: `il-${id}`, displayName: `IL ${id}` },
    });
    const adminWs = ws.json<{ accessToken: string; workspace: { organizationId: string } }>();

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${adminWs.accessToken}` },
    });
    const body = me.json<{ workspace: { inviteUrl: string | null } | null }>();
    expect(body.workspace).not.toBeNull();
    expect(body.workspace?.inviteUrl).toMatch(/\/invite\/[A-Za-z0-9_-]+$/);

    // Member path: read the org's invite_token off the DB so the joiner
    // can use it, then verify the joiner's /me hides the URL.
    const { organizations } = await import("../db/schema/organizations.js");
    const { eq } = await import("drizzle-orm");
    const [org] = await app.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, adminWs.workspace.organizationId))
      .limit(1);
    const token = org?.inviteToken ?? "";

    const memberId = `${Date.now()}il2`;
    const memberSignIn = await devSignIn({ githubId: memberId, login: `mem-${memberId}` });
    const join = await app.inject({
      method: "POST",
      url: "/api/v1/me/workspaces/join",
      headers: { authorization: `Bearer ${memberSignIn.accessToken}` },
      payload: { tokenOrUrl: token },
    });
    const memberWs = join.json<{ accessToken: string }>();

    const memberMe = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${memberWs.accessToken}` },
    });
    const memberBody = memberMe.json<{ workspace: { inviteUrl: string | null } | null }>();
    expect(memberBody.workspace).not.toBeNull();
    // Critical: members must NOT see the invite URL — they could re-share
    // it without admin oversight, and v1 has no per-link revocation.
    expect(memberBody.workspace?.inviteUrl).toBeNull();
  });

  it("admin invite URL uses server.publicUrl when configured (proxy-safe)", async () => {
    const original = app.config.server.publicUrl;
    (app.config.server as { publicUrl?: string }).publicUrl = "https://hub.example.com";
    try {
      const id = `${Date.now()}il3`;
      const signIn = await devSignIn({ githubId: id, login: `il3-${id}` });
      const ws = await app.inject({
        method: "POST",
        url: "/api/v1/me/workspaces/",
        headers: { authorization: `Bearer ${signIn.accessToken}` },
        payload: { name: `il3-${id}`, displayName: `IL3 ${id}` },
      });
      const adminWs = ws.json<{ accessToken: string }>();
      const me = await app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${adminWs.accessToken}` },
      });
      const body = me.json<{ workspace: { inviteUrl: string | null } | null }>();
      expect(body.workspace?.inviteUrl).toMatch(/^https:\/\/hub\.example\.com\/invite\//);
      expect(body.workspace?.inviteUrl).not.toContain("127.0.0.1");
    } finally {
      (app.config.server as { publicUrl?: string }).publicUrl = original;
    }
  });

  it("/health exposes commandVersion so `client connect` can warn on drift", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; commandVersion: string }>();
    expect(body.status).toBe("ok");
    expect(body.commandVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});
