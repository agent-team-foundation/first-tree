import { describe, expect, it } from "vitest";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("Context enablement handoff", () => {
  const getApp = useTestApp({ channel: "staging" });

  it("authors an exact Team, provider, and channel command for active members", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/context-enablement/handoff?provider=codex`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      protocolVersion: 1,
      organizationId: admin.organizationId,
      provider: "codex",
      intent: "settings",
      role: "admin",
    });
    expect(response.json().command).toBe(
      `'first-tree-staging' context enable --provider 'codex' --team '${admin.organizationId}' --yes`,
    );
    expect(response.body).not.toContain("--no-start");
  });

  it("pre-accepts the local plan without completing onboarding", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/context-enablement/handoff?provider=claude-code&intent=onboarding`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      protocolVersion: 1,
      organizationId: admin.organizationId,
      provider: "claude-code",
      intent: "onboarding",
    });
    expect(response.json().command).toBe(
      `'first-tree-staging' context enable --provider 'claude-code' --team '${admin.organizationId}' --yes`,
    );
    expect(response.body).not.toContain("--complete-onboarding");
  });
});
