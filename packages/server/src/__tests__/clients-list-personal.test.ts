import { describe, expect, it } from "vitest";
import { createAdminContext, seedClient, useTestApp } from "./helpers.js";

/**
 * `GET /api/v1/clients` — personal listing. A `client` is owned by exactly
 * one user (clients.user_id), so the list is scoped to the caller's user
 * regardless of which org they're currently viewing in the Web UI. The
 * org-admin audit view lives at `/api/v1/orgs/:orgId/clients` and is a
 * separate route.
 */
describe("GET /clients (personal)", () => {
  const getApp = useTestApp();

  it("returns only the caller's own clients", async () => {
    const app = getApp();
    const a = await createAdminContext(app);
    const b = await createAdminContext(app);

    // Add a second client for user A — verifies cross-org collation by user.
    const aSecond = await seedClient(app, a.userId, a.organizationId);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/clients",
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<{ id: string; userId: string }>;
    const ids = body.map((c) => c.id).sort();
    expect(ids).toEqual([a.clientId, aSecond].sort());
    // B's client must not leak into A's view.
    expect(ids).not.toContain(b.clientId);
    for (const row of body) expect(row.userId).toBe(a.userId);
  });

  it("requires authentication", async () => {
    const app = getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/clients" });
    expect(res.statusCode).toBe(401);
  });
});
