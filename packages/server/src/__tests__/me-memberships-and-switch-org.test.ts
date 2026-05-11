import { describe, expect, it } from "vitest";
import { createTestAdmin, useTestApp } from "./helpers.js";

/**
 * `/me` carries the full memberships list. The web client reads it +
 * `localStorage.selectedOrganizationId` to derive the current view. There
 * is no longer a `/auth/switch-org` endpoint — switching org is a pure
 * client-side state change, and every Class B / Class C route probes
 * membership in real time on each request, so a stale or unauthorized
 * selection just yields a clean 403/404 from the next API call.
 */
describe("/me: memberships + default org", () => {
  const getApp = useTestApp();

  it("GET /me includes a memberships array + defaultOrganizationId", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      defaultOrganizationId: string | null;
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
    expect(fromList?.agentId).toBe(admin.humanAgentUuid);
    expect(body.defaultOrganizationId).toBe(admin.organizationId);
  });
});
