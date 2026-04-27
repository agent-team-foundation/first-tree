import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clients as clientsTable } from "../db/schema/clients.js";
import { signOauthState } from "../services/auth-github.js";
import { uuidv7 } from "../uuid.js";
import { createTestApp } from "./helpers.js";

/**
 * Tests for the wizard's onboarding-state surface added in PR #5:
 *   * /me returns `member.onboardingState` (the JSONB checkpoint) AND
 *     `wizard.hasConnectedClientElsewhere` (cross-workspace skip signal
 *     for P0-5).
 *   * PATCH /me/onboarding-state writes the checkpoint, validating shape.
 */
describe("Wizard onboarding-state — /me + PATCH", () => {
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
    return { accessToken: fragment.get("access") ?? "", refreshToken: fragment.get("refresh") ?? "" };
  }

  async function createWs(token: string, slug: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/workspaces/",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: slug, displayName: `WS ${slug}` },
    });
    return res.json<{
      accessToken: string;
      refreshToken: string;
      workspace: { organizationId: string; memberId: string };
    }>();
  }

  it("/me returns null onboardingState for a fresh membership", async () => {
    const id = `${Date.now()}o1`;
    const signIn = await devSignIn({ githubId: id, login: `o1-${id}` });
    const ws = await createWs(signIn.accessToken, `ws-${id}`);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${ws.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json<{
      member: { onboardingState: null | { currentStep: string } };
      wizard: { hasConnectedClientElsewhere: boolean };
    }>();
    expect(body.member.onboardingState).toBeNull();
    expect(body.wizard.hasConnectedClientElsewhere).toBe(false);
  });

  it("PATCH /me/onboarding-state writes the checkpoint and /me reflects it", async () => {
    const id = `${Date.now()}o2`;
    const signIn = await devSignIn({ githubId: id, login: `o2-${id}` });
    const ws = await createWs(signIn.accessToken, `ws-${id}`);

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/v1/me/onboarding-state",
      headers: { authorization: `Bearer ${ws.accessToken}` },
      payload: { currentStep: "create_agent" },
    });
    expect(patch.statusCode).toBe(204);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${ws.accessToken}` },
    });
    const body = me.json<{ member: { onboardingState: { currentStep: string } | null } }>();
    expect(body.member.onboardingState).toEqual({ currentStep: "create_agent" });
  });

  it("PATCH /me/onboarding-state rejects an invalid currentStep value", async () => {
    const id = `${Date.now()}o3`;
    const signIn = await devSignIn({ githubId: id, login: `o3-${id}` });
    const ws = await createWs(signIn.accessToken, `ws-${id}`);

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/v1/me/onboarding-state",
      headers: { authorization: `Bearer ${ws.accessToken}` },
      payload: { currentStep: "not_a_real_step" },
    });
    expect(patch.statusCode).toBe(400);
  });

  it("hasConnectedClientElsewhere is true when the user has a connected client in ANOTHER workspace", async () => {
    // Set up: user creates workspace A, then workspace B. Seed a connected
    // client in A. Hit /me with the token scoped to B; the cross-workspace
    // skip signal should fire.
    const id = `${Date.now()}o4`;
    const signIn = await devSignIn({ githubId: id, login: `o4-${id}` });

    const wsA = await createWs(signIn.accessToken, `wsa-${id}`);
    const wsB = await createWs(wsA.accessToken, `wsb-${id}`);

    // Decode the token to fetch userId for the seed insert.
    // Easier: just SELECT from members to get userId for either ws.
    const { members } = await import("../db/schema/members.js");
    const { eq } = await import("drizzle-orm");
    const [memberA] = await app.db
      .select({ userId: members.userId, organizationId: members.organizationId })
      .from(members)
      .where(eq(members.id, wsA.workspace.memberId))
      .limit(1);
    if (!memberA) throw new Error("seeded member missing");

    // Insert a connected client owned by this user, scoped to ws A.
    await app.db.insert(clientsTable).values({
      id: `cli-elsewhere-${uuidv7().slice(-8)}`,
      userId: memberA.userId,
      organizationId: memberA.organizationId,
      status: "connected",
    });

    // Now /me with the ws B token should report the elsewhere flag.
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${wsB.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json<{ wizard: { hasConnectedClientElsewhere: boolean } }>();
    expect(body.wizard.hasConnectedClientElsewhere).toBe(true);

    // And /me on ws A itself should still report FALSE — the elsewhere
    // signal explicitly excludes the current workspace so the wizard's
    // own polling sees the local client.
    const meA = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${wsA.accessToken}` },
    });
    const bodyA = meA.json<{ wizard: { hasConnectedClientElsewhere: boolean } }>();
    expect(bodyA.wizard.hasConnectedClientElsewhere).toBe(false);
  });
});
