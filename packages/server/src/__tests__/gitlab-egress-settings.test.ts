import { describe, expect, it } from "vitest";
import { createGitlabConnection } from "../services/gitlab-connections.js";
import * as orgSettingsService from "../services/org-settings.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("GitLab egress authorization on Settings writes", () => {
  const getApp = useTestApp({
    gitlabEgressAllowlist: [
      {
        origin: "https://gitlab.authorized:8443",
        addressPolicy: { kind: "cidrs", cidrs: ["10.20.0.0/16"] },
      },
    ],
  });

  it("accepts only an exact allowlisted connection origin", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/gitlab-connections`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { displayName: "Authorized GitLab", instanceOrigin: "https://gitlab.authorized:8443" },
    });
    expect(accepted.statusCode).toBe(201);

    const other = await createTestAdmin(app);
    const wrongPort = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${other.organizationId}/gitlab-connections`,
      headers: { authorization: `Bearer ${other.accessToken}` },
      payload: { displayName: "Wrong port", instanceOrigin: "https://gitlab.authorized" },
    });
    expect(wrongPort.statusCode).toBe(400);
    expect(wrongPort.json()).toMatchObject({
      error: expect.stringMatching(/deployment egress allowlist/u),
    });
  });

  it("rejects a new binding when connection or allowlist authority is absent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await expect(
      orgSettingsService.putOrgSetting(
        app.db,
        admin.organizationId,
        "context_tree",
        {
          provider: "gitlab",
          repo: "https://gitlab.authorized:8443/acme/context.git",
          branch: "main",
        },
        {
          updatedBy: admin.userId,
          gitlabEgressAllowlist: app.config.gitlab?.egressAllowlist ?? [],
        },
      ),
    ).rejects.toThrow(/requires a current GitLab connection/u);

    await createGitlabConnection(app.db, {
      organizationId: admin.organizationId,
      memberId: admin.memberId,
      displayName: "Different origin",
      instanceOrigin: "https://gitlab.other",
    });
    await expect(
      orgSettingsService.putOrgSetting(
        app.db,
        admin.organizationId,
        "context_tree",
        {
          provider: "gitlab",
          repo: "https://gitlab.authorized:8443/acme/context.git",
          branch: "main",
        },
        {
          updatedBy: admin.userId,
          gitlabEgressAllowlist: app.config.gitlab?.egressAllowlist ?? [],
        },
      ),
    ).rejects.toThrow(/must match the current GitLab connection origin/u);
  });

  it("preserves an existing binding when the operator removes its allowlist entry", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await createGitlabConnection(app.db, {
      organizationId: admin.organizationId,
      memberId: admin.memberId,
      displayName: "Authorized GitLab",
      instanceOrigin: "https://gitlab.authorized:8443",
    });
    await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      {
        provider: "gitlab",
        repo: "https://gitlab.authorized:8443/acme/context.git",
        branch: "main",
      },
      {
        updatedBy: admin.userId,
        gitlabEgressAllowlist: app.config.gitlab?.egressAllowlist ?? [],
      },
    );

    await expect(
      orgSettingsService.putOrgSetting(
        app.db,
        admin.organizationId,
        "context_tree",
        { branch: "trunk" },
        { updatedBy: admin.userId, gitlabEgressAllowlist: [] },
      ),
    ).rejects.toThrow(/not authorized/u);
    await expect(orgSettingsService.getOrgContextTreeBinding(app.db, admin.organizationId)).resolves.toMatchObject({
      branch: "main",
      provider: "gitlab",
    });
  });
});
