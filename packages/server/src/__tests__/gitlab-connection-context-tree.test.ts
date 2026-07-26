import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { createGitlabConnection, replaceGitlabConnection } from "../services/gitlab-connections.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("GitLab connection and Context Tree origin consistency", () => {
  const getApp = useTestApp();

  it("rejects a new connection with another origin and permits the exact bound origin", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await app.db.insert(organizationSettings).values({
      organizationId: admin.organizationId,
      namespace: "context_tree",
      value: {
        provider: "gitlab",
        repo: "https://gitlab-a.example/platform/context-tree.git",
        branch: "main",
      },
      updatedBy: admin.userId,
    });

    await expect(
      createGitlabConnection(app.db, {
        organizationId: admin.organizationId,
        memberId: admin.memberId,
        displayName: "Wrong GitLab",
        instanceOrigin: "https://gitlab-b.example",
      }),
    ).rejects.toThrow("must match");
    expect(
      await app.db
        .select({ id: gitlabConnections.id })
        .from(gitlabConnections)
        .where(eq(gitlabConnections.organizationId, admin.organizationId)),
    ).toEqual([]);

    const created = await createGitlabConnection(app.db, {
      organizationId: admin.organizationId,
      memberId: admin.memberId,
      displayName: "GitLab A",
      instanceOrigin: "https://gitlab-a.example",
    });
    expect(created.connectionId).toBeTruthy();
  });

  it("preserves the current connection when replacement origin conflicts with the live binding", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const current = await createGitlabConnection(app.db, {
      organizationId: admin.organizationId,
      memberId: admin.memberId,
      displayName: "GitLab A",
      instanceOrigin: "https://gitlab-a.example",
    });
    await app.db.insert(organizationSettings).values({
      organizationId: admin.organizationId,
      namespace: "context_tree",
      value: {
        provider: "gitlab",
        repo: "https://gitlab-a.example/platform/context-tree.git",
        branch: "main",
      },
      updatedBy: admin.userId,
    });

    await expect(
      replaceGitlabConnection(app.db, {
        organizationId: admin.organizationId,
        memberId: admin.memberId,
        displayName: "GitLab B",
        instanceOrigin: "https://gitlab-b.example",
        expectedConnectionId: current.connectionId,
      }),
    ).rejects.toThrow("must match");
    expect(
      await app.db
        .select({ id: gitlabConnections.id, origin: gitlabConnections.instanceOrigin })
        .from(gitlabConnections)
        .where(eq(gitlabConnections.organizationId, admin.organizationId)),
    ).toEqual([{ id: current.connectionId, origin: "https://gitlab-a.example" }]);

    const replacement = await replaceGitlabConnection(app.db, {
      organizationId: admin.organizationId,
      memberId: admin.memberId,
      displayName: "GitLab A replacement",
      instanceOrigin: "https://gitlab-a.example",
      expectedConnectionId: current.connectionId,
    });
    expect(replacement.connectionId).not.toBe(current.connectionId);
  });
});
