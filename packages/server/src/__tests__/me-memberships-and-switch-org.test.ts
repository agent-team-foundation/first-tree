import { describe, expect, it } from "vitest";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * Decouple-client-from-identity §4.6 (PR-C):
 *   - `/me` returns a `memberships` array — the web client uses it to
 *     derive `currentMembership` from `localStorage.selectedOrganizationId`
 *     without re-issuing tokens.
 *   - `/auth/switch-org` is now a server-side authorization probe that
 *     returns 204 on success / 403 when the user is not an active member;
 *     it no longer mints new JWTs, and consequently does not need to
 *     touch any WS connection.
 */
describe("PR-C: /me memberships + /auth/switch-org degrade", () => {
  const getApp = useTestApp();

  it("GET /me includes a memberships array with the caller's active orgs", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      member: { id: string; organizationId: string; role: string; agentId: string };
      memberships: Array<{
        id: string;
        organizationId: string;
        organizationName: string;
        role: string;
        agentId: string;
      }>;
    }>();

    expect(body.memberships.length).toBeGreaterThanOrEqual(1);
    const fromList = body.memberships.find((m) => m.id === admin.memberId);
    expect(fromList?.organizationId).toBe(admin.organizationId);
    expect(fromList?.role).toBe("admin");
    expect(fromList?.agentId).toBe(body.member.agentId);
  });

  it("POST /auth/switch-org returns 204 when the caller is an active member", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/switch-org",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { organizationId: admin.organizationId },
    });
    expect(res.statusCode).toBe(204);
    expect(res.payload).toBe("");
  });

  it("POST /auth/switch-org rejects orgs the user does not belong to", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/switch-org",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { organizationId: "00000000-0000-7000-8000-000000000000" },
    });
    expect(res.statusCode).toBe(403);
  });
});
