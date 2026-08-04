import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { members } from "../db/schema/members.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { putOrgSetting } from "../services/org-settings.js";
import { createOrganization } from "../services/organization.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("org-scoped member Context activation", () => {
  const getApp = useTestApp();

  it.each([
    [{ schemaVersion: 2 }, 2],
    [{ schemaVersion: 1, repositoryKey: "github.com/acme/unregistered-source" }, 1],
  ] as const)("validates Team membership and Tree readiness for contract %#", async (body, schemaVersion) => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const request = () =>
      app.inject({
        method: "POST",
        url: `/api/v1/orgs/${admin.organizationId}/context-activation/validate`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: body,
      });

    const unbound = await request();
    expect(unbound.statusCode).toBe(200);
    expect(unbound.json()).toMatchObject({
      schemaVersion,
      outcome: "needs_admin",
      reasonCode: "context_tree_unbound",
      team: { organizationId: admin.organizationId, role: "admin" },
      nextAction: { settingsUrl: "/settings/context#binding" },
    });

    await putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      {
        provider: "github",
        repo: "https://github.com/acme/context-tree.git",
        branch: "main",
      },
      { updatedBy: admin.userId, memberId: admin.memberId },
    );

    const connected = await request();
    expect(connected.statusCode).toBe(200);
    expect(connected.json()).toMatchObject({
      schemaVersion,
      outcome: "connected",
      team: { organizationId: admin.organizationId, role: "admin" },
    });

    await app.db.update(members).set({ status: "left" }).where(eq(members.id, admin.memberId));
    expect((await request()).statusCode).toBe(403);
  });

  it("takes Team only from the encoded org path and removes the old /me route", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const foreign = await createOrganization(app.db, {
      name: `foreign-${crypto.randomUUID()}`,
      displayName: "Foreign Team",
    });
    const payload = { schemaVersion: 2 };

    const nonMember = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(foreign.id)}/context-activation/validate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload,
    });
    expect(nonMember.statusCode).toBe(403);

    const bodyOverride = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${encodeURIComponent(admin.organizationId)}/context-activation/validate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { ...payload, organizationId: foreign.id },
    });
    expect(bodyOverride.statusCode).toBe(400);

    const oldRoute = await app.inject({
      method: "POST",
      url: "/api/v1/me/context-activation/validate",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload,
    });
    expect(oldRoute.statusCode).toBe(404);
  });

  it("keeps v1 repositoryKey canonicalization at the compatibility boundary", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/context-activation/validate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        schemaVersion: 1,
        repositoryKey: "https://token@github.com/acme/repo.git",
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("batch-validates only explicit local routing candidates without enumerating memberships", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      { provider: "github", repo: "https://github.com/acme/context-tree.git", branch: "main" },
      { updatedBy: admin.userId, memberId: admin.memberId },
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/me/context-activation/candidates/validate",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { schemaVersion: 1, organizationIds: [admin.organizationId, "org-not-authorized"] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schemaVersion: 1,
      candidates: [
        {
          organizationId: admin.organizationId,
          outcome: "connected",
          team: expect.objectContaining({ organizationId: admin.organizationId, role: "admin" }),
          binding: { provider: "github", repo: "https://github.com/acme/context-tree.git", branch: "main" },
        },
        {
          organizationId: "org-not-authorized",
          outcome: "unavailable",
          reasonCode: "not_member",
          message: expect.any(String),
        },
      ],
    });
  });

  it("projects one normalized binding for providerless route and member-safe snapshot authority", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const legacyBinding = {
      repo: "git@github.com:acme/context-tree.git",
      branch: "main",
    };
    await app.db.insert(organizationSettings).values({
      organizationId: admin.organizationId,
      namespace: "context_tree",
      value: legacyBinding,
      version: 3,
      updatedBy: admin.userId,
    });

    const settings = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/settings/context_tree`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toEqual({ provider: "github", ...legacyBinding });

    const routed = await app.inject({
      method: "POST",
      url: "/api/v1/me/context-activation/candidates/validate",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { schemaVersion: 1, organizationIds: [admin.organizationId] },
    });
    expect(routed.statusCode).toBe(200);
    expect(routed.json()).toMatchObject({
      schemaVersion: 1,
      candidates: [
        {
          organizationId: admin.organizationId,
          outcome: "connected",
          binding: settings.json(),
        },
      ],
    });

    await app.db
      .update(organizationSettings)
      .set({ value: { ...legacyBinding, provider: "gitlab" } })
      .where(
        and(
          eq(organizationSettings.organizationId, admin.organizationId),
          eq(organizationSettings.namespace, "context_tree"),
        ),
      );
    const changedProvider = await app.inject({
      method: "POST",
      url: "/api/v1/me/context-activation/candidates/validate",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { schemaVersion: 1, organizationIds: [admin.organizationId] },
    });
    expect(changedProvider.statusCode).toBe(200);
    expect(changedProvider.json()).toMatchObject({
      candidates: [
        {
          organizationId: admin.organizationId,
          outcome: "unavailable",
          reasonCode: "context_tree_provider_unresolved",
        },
      ],
    });
  });

  it("issues a stateless session-only receipt and binds validation to its provider/project", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      { provider: "github", repo: "https://github.com/acme/context-tree.git", branch: "main" },
      { updatedBy: admin.userId, memberId: admin.memberId },
    );
    const project = { kind: "path" as const, root: "/tmp/codex-session" };
    const issued = await app.inject({
      method: "POST",
      url: "/api/v1/me/context-activation/session-candidate/issue",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {
        schemaVersion: 1,
        provider: "codex",
        project,
        organizationId: admin.organizationId,
      },
    });
    expect(issued.statusCode).toBe(200);
    const receipt = issued.json<{ receipt: string }>().receipt;
    expect(receipt).toEqual(expect.any(String));

    const validate = (candidateProject: typeof project) =>
      app.inject({
        method: "POST",
        url: "/api/v1/me/context-activation/session-candidate/validate",
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: { schemaVersion: 1, provider: "codex", project: candidateProject, receipt },
      });
    const accepted = await validate(project);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      candidates: [{ organizationId: admin.organizationId, outcome: "connected" }],
    });
    expect((await validate({ kind: "path", root: "/tmp/changed" })).statusCode).toBe(403);

    const tampered = `${receipt.slice(0, -1)}${receipt.endsWith("a") ? "b" : "a"}`;
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/me/context-activation/session-candidate/validate",
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { schemaVersion: 1, provider: "codex", project, receipt: tampered },
    });
    expect(rejected.statusCode).toBe(401);
  });
});
