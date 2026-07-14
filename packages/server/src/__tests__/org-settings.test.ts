import crypto, { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { members } from "../db/schema/members.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { organizations } from "../db/schema/organizations.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import { signTokensForUser } from "../services/auth.js";
import * as orgSettingsService from "../services/org-settings.js";
import { uuidv7 } from "../uuid.js";
import { createAdminContext, createTestAdmin, INVALID_BCRYPT_PLACEHOLDER, useTestApp } from "./helpers.js";

const TEST_JWT_SECRET = "test-jwt-secret-key-for-vitest";

async function createReviewerAgent(
  app: FastifyInstance,
  input: {
    clientId?: string;
    displayName?: string;
    managerId: string;
    name?: string;
    organizationId?: string;
    status?: "active" | "suspended" | "deleted";
    type?: "agent" | "human";
  },
) {
  const agent = await createAgent(app.db, {
    name: input.name ?? `reviewer-${crypto.randomUUID().slice(0, 8)}`,
    type: input.type ?? "agent",
    displayName: input.displayName ?? "Context Reviewer",
    managerId: input.managerId,
    organizationId: input.organizationId,
    clientId: input.type === "human" ? undefined : input.clientId,
  });
  if (input.status && input.status !== "active") {
    const [updated] = await app.db
      .update(agents)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(agents.uuid, agent.uuid))
      .returning();
    if (!updated) throw new Error("reviewer agent status update failed");
    return updated;
  }
  return agent;
}

describe("org-settings service", () => {
  const getApp = useTestApp();

  it("getOrgSetting returns namespace defaults when no row exists", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const ct = await orgSettingsService.getOrgSetting(app.db, admin.organizationId, "context_tree");
    expect(ct).toEqual({ branch: "main" });
  });

  it("putOrgSetting stores context_tree and round-trips via getOrgSetting", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const out = await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      { repo: "https://github.com/example/tree", branch: "main" },
      { updatedBy: admin.userId },
    );
    expect(out).toMatchObject({ repo: "https://github.com/example/tree", branch: "main" });

    const re = await orgSettingsService.getOrgSetting(app.db, admin.organizationId, "context_tree");
    expect(re).toEqual(out);
  });

  it("putOrgSetting input semantics: undefined unchanged, null clears, value sets", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      { repo: "https://github.com/example/tree", branch: "v2" },
      { updatedBy: admin.userId },
    );

    // undefined `repo` leaves it intact; null `branch` clears (server falls back to "main").
    const after = await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      { branch: null },
      { updatedBy: admin.userId },
    );
    expect(after).toEqual({ repo: "https://github.com/example/tree", branch: "main" });
  });

  it("putOrgSetting replaces the repo without changing an existing branch", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      { repo: "https://github.com/example/original.git", branch: "release/2026-07" },
      { updatedBy: admin.userId },
    );

    const rebound = await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      { repo: "git@github.com:example/rebound.git" },
      { updatedBy: admin.userId },
    );
    expect(rebound).toEqual({ repo: "git@github.com:example/rebound.git", branch: "release/2026-07" });
  });

  it("can read and repair a historical Context Tree row that is looser than the write schema", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const historical = { repo: "http://legacy.example.com/context-tree.git", branch: " legacy\nbranch " };
    await app.db.insert(organizationSettings).values({
      organizationId: admin.organizationId,
      namespace: "context_tree",
      value: historical,
      version: 1,
      updatedBy: admin.userId,
    });

    await expect(orgSettingsService.getOrgSetting(app.db, admin.organizationId, "context_tree")).resolves.toEqual(
      historical,
    );

    const repaired = await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      { repo: "https://github.com/example/repaired.git", branch: "main" },
      { updatedBy: admin.userId },
    );
    expect(repaired).toEqual({ repo: "https://github.com/example/repaired.git", branch: "main" });

    const [row] = await app.db
      .select({ value: organizationSettings.value, version: organizationSettings.version })
      .from(organizationSettings)
      .where(
        and(
          eq(organizationSettings.organizationId, admin.organizationId),
          eq(organizationSettings.namespace, "context_tree"),
        ),
      );
    expect(row).toEqual({
      value: { repo: "https://github.com/example/repaired.git", branch: "main" },
      version: 2,
    });
  });

  it("rejects empty-string repo at the schema layer (#3)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    await expect(
      orgSettingsService.putOrgSetting(
        app.db,
        admin.organizationId,
        "context_tree",
        { repo: "" },
        { updatedBy: admin.userId },
      ),
    ).rejects.toThrow();
  });

  it("accepts HTTPS, ssh://, and scp-like Context Tree repo URLs (no embedded credentials)", async () => {
    // Schema accepts both protocols so the client-side fallback layer can
    // pick whichever the user has credentials for. We still reject embedded
    // credentials (logs / API responses would leak them) and `http://`
    // (plaintext, MITM-able).
    const app = getApp();
    const admin = await createTestAdmin(app);
    const putRepo = (repo: string) =>
      orgSettingsService.putOrgSetting(
        app.db,
        admin.organizationId,
        "context_tree",
        { repo },
        { updatedBy: admin.userId },
      );

    // All three accepted forms.
    await expect(putRepo("https://github.com/example/tree.git")).resolves.toBeDefined();
    await expect(putRepo("ssh://git@github.com/example/tree.git")).resolves.toBeDefined();
    await expect(putRepo("git@github.com:example/tree.git")).resolves.toBeDefined();

    // Embedded credentials always rejected, regardless of protocol.
    await expect(putRepo("https://user:secret@github.com/example/tree.git")).rejects.toThrow(/credentials/);
    await expect(putRepo("ssh://git:secret@github.com/example/tree.git")).rejects.toThrow(/credentials/);
    // Plaintext / unauthenticated protocols still rejected.
    await expect(putRepo("http://github.com/example/tree")).rejects.toThrow();
    await expect(putRepo("git://github.com/example/tree")).rejects.toThrow();
  });

  it("putOrgSetting bumps version on subsequent writes", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      { repo: "https://github.com/example/a" },
      { updatedBy: admin.userId },
    );
    const [v1] = await app.db
      .select({ version: organizationSettings.version })
      .from(organizationSettings)
      .where(
        and(
          eq(organizationSettings.organizationId, admin.organizationId),
          eq(organizationSettings.namespace, "context_tree"),
        ),
      );
    expect(v1?.version).toBe(1);

    await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      { repo: "https://github.com/example/b" },
      { updatedBy: admin.userId },
    );
    const [v2] = await app.db
      .select({ version: organizationSettings.version })
      .from(organizationSettings)
      .where(
        and(
          eq(organizationSettings.organizationId, admin.organizationId),
          eq(organizationSettings.namespace, "context_tree"),
        ),
      );
    expect(v2?.version).toBe(2);
  });

  it("deleteOrgSetting drops the row; subsequent get returns defaults", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      { repo: "https://github.com/example/x" },
      { updatedBy: admin.userId },
    );
    await orgSettingsService.deleteOrgSetting(app.db, admin.organizationId, "context_tree");

    const after = await orgSettingsService.getOrgSetting(app.db, admin.organizationId, "context_tree");
    expect(after).toEqual({ branch: "main" });
  });

  it("source_repos defaults to empty list when no row exists", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const out = await orgSettingsService.getOrgSetting(app.db, admin.organizationId, "source_repos");
    expect(out).toEqual({ repos: [] });
  });

  it("source_repos round-trips a list of entries", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const put = await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "source_repos",
      {
        repos: [
          { url: "https://github.com/example/one" },
          { url: "https://github.com/example/two", defaultBranch: "develop" },
        ],
      },
      { updatedBy: admin.userId },
    );
    expect(put).toEqual({
      repos: [
        { url: "https://github.com/example/one" },
        { url: "https://github.com/example/two", defaultBranch: "develop" },
      ],
    });

    const re = await orgSettingsService.getOrgSetting(app.db, admin.organizationId, "source_repos");
    expect(re).toEqual(put);
  });

  it("source_repos PUT with undefined repos leaves the list intact", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "source_repos",
      { repos: [{ url: "https://github.com/example/keep" }] },
      { updatedBy: admin.userId },
    );

    // No `repos` field in the PUT body — current list must survive.
    const after = await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "source_repos",
      {},
      { updatedBy: admin.userId },
    );
    expect(after).toEqual({ repos: [{ url: "https://github.com/example/keep" }] });
  });

  it("source_repos PUT with empty array clears the list", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "source_repos",
      { repos: [{ url: "https://github.com/example/will-clear" }] },
      { updatedBy: admin.userId },
    );
    const cleared = await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "source_repos",
      { repos: [] },
      { updatedBy: admin.userId },
    );
    expect(cleared).toEqual({ repos: [] });
  });

  it("source_repos rejects malformed url at the schema layer", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await expect(
      orgSettingsService.putOrgSetting(
        app.db,
        admin.organizationId,
        "source_repos",
        { repos: [{ url: "not-a-url" }] },
        { updatedBy: admin.userId },
      ),
    ).rejects.toThrow();
  });

  it("source_repos rejects insecure / unauthenticated protocols (http://, git://)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const putUrl = (url: string) =>
      orgSettingsService.putOrgSetting(
        app.db,
        admin.organizationId,
        "source_repos",
        { repos: [{ url }] },
        { updatedBy: admin.userId },
      );

    await expect(putUrl("http://github.com/example/insecure")).rejects.toThrow(/HTTPS or SSH/);
    await expect(putUrl("git://github.com/example/insecure")).rejects.toThrow();
  });

  it("source_repos accepts ssh:// and scp-like SSH URLs alongside HTTPS", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const out = await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "source_repos",
      {
        repos: [
          { url: "https://github.com/example/https-form" },
          { url: "ssh://git@github.com/example/ssh-url-form.git" },
          { url: "git@github.com:example/scp-form.git" },
        ],
      },
      { updatedBy: admin.userId },
    );
    expect(out.repos).toHaveLength(3);
    expect(out.repos.map((r) => r.url)).toEqual([
      "https://github.com/example/https-form",
      "ssh://git@github.com/example/ssh-url-form.git",
      "git@github.com:example/scp-form.git",
    ]);
  });

  it("source_repos rejects URLs with embedded credentials", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await expect(
      orgSettingsService.putOrgSetting(
        app.db,
        admin.organizationId,
        "source_repos",
        { repos: [{ url: "https://user:secret@github.com/example/leaky" }] },
        { updatedBy: admin.userId },
      ),
    ).rejects.toThrow(/credentials/);
  });

  it("context_tree_features defaults to disabled reviewer when no row exists", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const out = await orgSettingsService.getOrgSetting(app.db, admin.organizationId, "context_tree_features");
    expect(out).toEqual({ contextReviewer: { enabled: false, agentUuid: null, reviewerAgent: null } });
  });

  it("context_tree_features stores an active non-human reviewer in the organization and round-trips", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const otherManager = await createAdminContext(app);
    const reviewer = await createReviewerAgent(app, { managerId: otherManager.memberId });

    const out = await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree_features",
      { contextReviewer: { enabled: true, agentUuid: reviewer.uuid } },
      { updatedBy: admin.userId, memberId: admin.memberId },
    );
    expect(out).toEqual({
      contextReviewer: {
        enabled: true,
        agentUuid: reviewer.uuid,
        reviewerAgent: { uuid: reviewer.uuid, name: reviewer.name, displayName: reviewer.displayName },
      },
    });

    const re = await orgSettingsService.getOrgSetting(app.db, admin.organizationId, "context_tree_features");
    expect(re).toEqual(out);
  });

  it("context_tree_features clears agentUuid when disabled", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewerAgent(app, {
      clientId: admin.clientId,
      managerId: admin.memberId,
    });

    await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree_features",
      { contextReviewer: { enabled: true, agentUuid: reviewer.uuid } },
      { updatedBy: admin.userId, memberId: admin.memberId },
    );
    const disabled = await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree_features",
      { contextReviewer: { enabled: false, agentUuid: reviewer.uuid } },
      { updatedBy: admin.userId, memberId: admin.memberId },
    );

    expect(disabled).toEqual({ contextReviewer: { enabled: false, agentUuid: null, reviewerAgent: null } });
  });

  it("context_tree_features rejects enabled reviewer input without agentUuid", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);

    await expect(
      orgSettingsService.putOrgSetting(
        app.db,
        admin.organizationId,
        "context_tree_features",
        { contextReviewer: { enabled: true, agentUuid: null } },
        { updatedBy: admin.userId, memberId: admin.memberId },
      ),
    ).rejects.toThrow(/agentUuid is required/);
  });

  it("context_tree_features rejects enabled reviewer assignment without active member context", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewerAgent(app, {
      clientId: admin.clientId,
      managerId: admin.memberId,
    });

    await expect(
      orgSettingsService.putOrgSetting(
        app.db,
        admin.organizationId,
        "context_tree_features",
        { contextReviewer: { enabled: true, agentUuid: reviewer.uuid } },
        { updatedBy: admin.userId },
      ),
    ).rejects.toThrow(/active member/);
  });

  it("context_tree_features rejects human, suspended, and side-org reviewers", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const suspended = await createReviewerAgent(app, {
      clientId: admin.clientId,
      managerId: admin.memberId,
      status: "suspended",
    });
    const sideOrgId = `org-reviewer-${crypto.randomUUID().slice(0, 8)}`;
    const sideMemberId = uuidv7();
    await app.db.transaction(async (tx) => {
      await tx.insert(organizations).values({
        id: sideOrgId,
        name: `reviewer-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Reviewer Side Org",
      });
      const human = await createAgent(tx as unknown as typeof app.db, {
        name: `reviewer-side-human-${crypto.randomUUID().slice(0, 8)}`,
        type: "human",
        displayName: "Reviewer Side Human",
        managerId: sideMemberId,
        organizationId: sideOrgId,
      });
      await tx.insert(members).values({
        id: sideMemberId,
        userId: admin.userId,
        organizationId: sideOrgId,
        agentId: human.uuid,
        role: "admin",
      });
    });
    const sideOrgAgent = await createReviewerAgent(app, {
      managerId: sideMemberId,
      organizationId: sideOrgId,
    });

    const putReviewer = (agentUuid: string) =>
      orgSettingsService.putOrgSetting(
        app.db,
        admin.organizationId,
        "context_tree_features",
        { contextReviewer: { enabled: true, agentUuid } },
        { updatedBy: admin.userId, memberId: admin.memberId },
      );

    await expect(putReviewer(admin.humanAgentUuid)).rejects.toThrow(/active non-human agent in this organization/);
    await expect(putReviewer(suspended.uuid)).rejects.toThrow(/active non-human agent in this organization/);
    await expect(putReviewer(sideOrgAgent.uuid)).rejects.toThrow(/active non-human agent in this organization/);
  });

  it("rejects unknown namespace with BadRequestError", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await expect(orgSettingsService.getOrgSetting(app.db, admin.organizationId, "nope" as never)).rejects.toThrow(
      /Unknown organization-settings namespace/,
    );
  });

  it("rejects PUT against unknown org with NotFoundError", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await expect(
      orgSettingsService.putOrgSetting(
        app.db,
        "00000000-0000-0000-0000-000000000000",
        "context_tree",
        { repo: "https://github.com/example/x" },
        { updatedBy: admin.userId },
      ),
    ).rejects.toThrow(/Organization .* not found/);
  });
});

describe("resolveUserPrimaryOrgId", () => {
  const getApp = useTestApp();

  /**
   * Add an extra membership for an existing user. `createdAt` is exposed so
   * tests can deterministically control which membership is "most recent".
   */
  async function addMembership(
    app: Awaited<ReturnType<typeof getApp>>,
    userId: string,
    role: "admin" | "member",
    createdAt?: Date,
    status: "active" | "left" = "active",
  ): Promise<{ orgId: string; memberId: string }> {
    const orgId = `org-rup-${crypto.randomUUID().slice(0, 8)}`;
    const memberId = uuidv7();
    await app.db.transaction(async (tx) => {
      await tx.insert(organizations).values({ id: orgId, name: orgId.slice(0, 30), displayName: "Side org" });
      const human = await createAgent(tx as unknown as typeof app.db, {
        name: `rup-h-${crypto.randomUUID().slice(0, 6)}`,
        type: "human",
        displayName: "RUP Human",
        managerId: memberId,
        organizationId: orgId,
      });
      await tx.insert(members).values({
        id: memberId,
        userId,
        organizationId: orgId,
        agentId: human.uuid,
        role,
        status,
        ...(createdAt ? { createdAt } : {}),
      });
    });
    return { orgId, memberId };
  }

  it("returns the only active membership when user has one org", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const got = await orgSettingsService.resolveUserPrimaryOrgId(app.db, admin.userId);
    expect(got).toBe(admin.organizationId);
  });

  it("returns most-recent active membership for multi-org users (matches /me's defaultOrganizationId)", async () => {
    const app = getApp();
    // First org via createTestAdmin. Force its membership createdAt to a known
    // earlier moment so we can deterministically assert "most recent wins"
    // regardless of how fast the test runs.
    const admin = await createTestAdmin(app);
    const earlier = new Date(Date.now() - 60_000);
    await app.db.update(members).set({ createdAt: earlier }).where(eq(members.id, admin.memberId));

    // Second org — created "now", which is more recent than `earlier`.
    const later = await addMembership(app, admin.userId, "admin", new Date());

    const got = await orgSettingsService.resolveUserPrimaryOrgId(app.db, admin.userId);
    expect(got).toBe(later.orgId);
    expect(got).not.toBe(admin.organizationId);
  });

  it("ignores 'left' memberships even when their createdAt is more recent", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    // A more-recent membership the user has since left.
    await addMembership(app, admin.userId, "admin", new Date(Date.now() + 60_000), "left");

    const got = await orgSettingsService.resolveUserPrimaryOrgId(app.db, admin.userId);
    expect(got).toBe(admin.organizationId);
  });

  it("returns null when user has no active memberships", async () => {
    const app = getApp();
    const userId = uuidv7();
    const passwordHash = await bcrypt.hash(crypto.randomUUID(), 4);
    await app.db.insert(users).values({
      id: userId,
      username: `nomembers-${crypto.randomUUID().slice(0, 8)}`,
      passwordHash,
      displayName: "No Memberships",
    });

    const got = await orgSettingsService.resolveUserPrimaryOrgId(app.db, userId);
    expect(got).toBeNull();
  });
});

describe("org-settings API (admin gating + masking)", () => {
  const getApp = useTestApp();

  async function adminAndMember(app: Awaited<ReturnType<typeof getApp>>) {
    const admin = await createTestAdmin(app);

    // Seed a second user joined to the same org with role "member".
    const memberUserId = uuidv7();
    const memberMemberId = uuidv7();
    const username = `member-${memberUserId.slice(0, 8)}`;
    const passwordHash = await bcrypt.hash("placeholder", 1).catch(() => INVALID_BCRYPT_PLACEHOLDER);
    await app.db.transaction(async (tx) => {
      await tx.insert(users).values({ id: memberUserId, username, passwordHash, displayName: "Member" });
      const humanAgent = await createAgent(tx as unknown as typeof app.db, {
        name: `member-human-${memberUserId.slice(0, 8)}`,
        type: "human",
        displayName: "Member",
        managerId: memberMemberId,
        organizationId: admin.organizationId,
      });
      await tx.insert(members).values({
        id: memberMemberId,
        userId: memberUserId,
        organizationId: admin.organizationId,
        agentId: humanAgent.uuid,
        role: "member",
      });
    });
    const memberTokens = await signTokensForUser(TEST_JWT_SECRET, memberUserId, {
      accessTokenExpiry: "30m",
      refreshTokenExpiry: "30d",
    });
    return { admin, member: { ...memberTokens, userId: memberUserId } };
  }

  async function attachOrg(app: Awaited<ReturnType<typeof getApp>>, userId: string) {
    const orgId = `org-ct-${randomUUID().slice(0, 8)}`;
    const memberId = uuidv7();
    await app.db.transaction(async (tx) => {
      await tx.insert(organizations).values({
        id: orgId,
        name: `ct-${randomUUID().slice(0, 8)}`,
        displayName: "Context Tree Side Org",
      });
      const humanAgent = await createAgent(tx as unknown as typeof app.db, {
        name: `ct-human-${randomUUID().slice(0, 8)}`,
        type: "human",
        displayName: "Context Tree Human",
        managerId: memberId,
        organizationId: orgId,
      });
      await tx.insert(members).values({
        id: memberId,
        userId,
        organizationId: orgId,
        agentId: humanAgent.uuid,
        role: "admin",
      });
    });
    return orgId;
  }

  it("admin can GET, PUT, DELETE the namespace", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const url = `/api/v1/orgs/${admin.organizationId}/settings/context_tree`;

    const get1 = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(get1.statusCode).toBe(200);
    expect(get1.json()).toEqual({ branch: "main" });

    const put = await app.inject({
      method: "PUT",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { repo: "https://github.com/example/api" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ repo: "https://github.com/example/api", branch: "main" });

    const branched = await app.inject({
      method: "PUT",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { repo: "https://github.com/example/api", branch: "api" },
    });
    expect(branched.statusCode).toBe(200);
    expect(branched.json()).toEqual({ repo: "https://github.com/example/api", branch: "api" });

    const rebound = await app.inject({
      method: "PUT",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { repo: "git@github.com:example/rebound-api.git" },
    });
    expect(rebound.statusCode).toBe(200);
    expect(rebound.json()).toEqual({ repo: "git@github.com:example/rebound-api.git", branch: "api" });

    const del = await app.inject({
      method: "DELETE",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(del.statusCode).toBe(204);

    const get2 = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(get2.json()).toEqual({ branch: "main" });
  });

  it("strictly validates Context Tree PUT bodies without partially updating the setting", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const url = `/api/v1/orgs/${admin.organizationId}/settings/context_tree`;
    const original = { repo: "https://github.com/example/original.git", branch: "release" };

    const initial = await app.inject({
      method: "PUT",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: original,
    });
    expect(initial.statusCode).toBe(200);

    for (const payload of [
      { repo: "https://github.com" },
      { repo: " https://github.com/example/tree.git" },
      { repo: "https://github.com/example/tree.git\u0000" },
      { repo: "https:/github.com/example/tree.git" },
      { repo: "https:///github.com/example/tree.git" },
      { repo: "https://github.com\\example/tree.git" },
      { repo: "C:\\workspace\\context-tree.git" },
      { repo: "https://github.com/example/tree.git?access_token=secret" },
      { repo: "https://github.com/example/tree.git\u2028forged" },
      { branch: "" },
      { branch: " release" },
      { branch: "release\nnext" },
      { repo: "https://github.com/example/new.git", branch: "main", unexpected: true },
    ]) {
      const res = await app.inject({
        method: "PUT",
        url,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }

    const [row] = await app.db
      .select({ value: organizationSettings.value, version: organizationSettings.version })
      .from(organizationSettings)
      .where(
        and(
          eq(organizationSettings.organizationId, admin.organizationId),
          eq(organizationSettings.namespace, "context_tree"),
        ),
      );
    expect(row).toEqual({ value: original, version: 1 });
  });

  it("context tree snapshot uses the org id from the route, not the caller's primary org", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const sideOrgId = await attachOrg(app, admin.userId);
    await orgSettingsService.putOrgSetting(
      app.db,
      sideOrgId,
      "context_tree",
      { repo: "https://github.com/example/current-team-context", branch: "--bad" },
      { updatedBy: admin.userId },
    );

    const sideSnapshot = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${sideOrgId}/context-tree/snapshot?window=7d`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(sideSnapshot.statusCode).toBe(200);
    expect(sideSnapshot.json()).toMatchObject({
      repo: "https://github.com/example/current-team-context",
      branch: "--bad",
      snapshotStatus: "unavailable",
    });

    const defaultSnapshot = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/context-tree/snapshot?window=7d`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(defaultSnapshot.statusCode).toBe(200);
    expect(defaultSnapshot.json()).toMatchObject({
      repo: null,
      snapshotStatus: "unavailable",
    });
  });

  it("non-admin member is forbidden from PUT / DELETE on context_tree (write is admin-only)", async () => {
    const app = getApp();
    const { admin, member } = await adminAndMember(app);
    const url = `/api/v1/orgs/${admin.organizationId}/settings/context_tree`;
    const original = { repo: "https://github.com/example/member-guard.git", branch: "main" };
    await orgSettingsService.putOrgSetting(app.db, admin.organizationId, "context_tree", original, {
      updatedBy: admin.userId,
    });

    for (const method of ["PUT", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${member.accessToken}` },
        ...(method === "PUT" ? { payload: { branch: "x" } } : {}),
      });
      expect(res.statusCode, `${method} should be 403 for non-admin`).toBe(403);
    }

    const [row] = await app.db
      .select({ value: organizationSettings.value, version: organizationSettings.version })
      .from(organizationSettings)
      .where(
        and(
          eq(organizationSettings.organizationId, admin.organizationId),
          eq(organizationSettings.namespace, "context_tree"),
        ),
      );
    expect(row).toEqual({ value: original, version: 1 });
  });

  it("re-evaluates admin membership on every Context Tree PUT and leaves the setting unchanged", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const url = `/api/v1/orgs/${admin.organizationId}/settings/context_tree`;
    const original = { repo: "https://github.com/example/realtime-guard.git", branch: "main" };
    await orgSettingsService.putOrgSetting(app.db, admin.organizationId, "context_tree", original, {
      updatedBy: admin.userId,
    });

    await app.db.update(members).set({ role: "member" }).where(eq(members.id, admin.memberId));
    const downgraded = await app.inject({
      method: "PUT",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { repo: "https://github.com/example/forbidden-downgrade.git" },
    });
    expect(downgraded.statusCode).toBe(403);
    await expect(orgSettingsService.getOrgSetting(app.db, admin.organizationId, "context_tree")).resolves.toEqual(
      original,
    );

    await app.db.update(members).set({ role: "admin", status: "left" }).where(eq(members.id, admin.memberId));
    const departed = await app.inject({
      method: "PUT",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { repo: "https://github.com/example/forbidden-departure.git" },
    });
    expect(departed.statusCode).toBe(403);

    const [row] = await app.db
      .select({ value: organizationSettings.value, version: organizationSettings.version })
      .from(organizationSettings)
      .where(
        and(
          eq(organizationSettings.organizationId, admin.organizationId),
          eq(organizationSettings.namespace, "context_tree"),
        ),
      );
    expect(row).toEqual({ value: original, version: 1 });
  });

  it("unknown namespace returns 400", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/settings/nope`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("source_repos remains readable but rejects generic route writes", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const url = `/api/v1/orgs/${admin.organizationId}/settings/source_repos`;

    const get1 = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(get1.statusCode).toBe(200);
    expect(get1.json()).toEqual({ repos: [] });

    const put = await app.inject({
      method: "PUT",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { repos: [{ url: "https://github.com/example/api" }] },
    });
    expect(put.statusCode).toBe(410);

    const del = await app.inject({
      method: "DELETE",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(del.statusCode).toBe(410);

    const get2 = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(get2.json()).toEqual({ repos: [] });
  });

  it("admin can GET and PUT context_tree_features through the generic settings route", async () => {
    const app = getApp();
    const admin = await createAdminContext(app);
    const reviewer = await createReviewerAgent(app, {
      clientId: admin.clientId,
      managerId: admin.memberId,
    });
    const url = `/api/v1/orgs/${admin.organizationId}/settings/context_tree_features`;

    const get1 = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(get1.statusCode).toBe(200);
    expect(get1.json()).toEqual({ contextReviewer: { enabled: false, agentUuid: null, reviewerAgent: null } });

    const put = await app.inject({
      method: "PUT",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { contextReviewer: { enabled: true, agentUuid: reviewer.uuid } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({
      contextReviewer: {
        enabled: true,
        agentUuid: reviewer.uuid,
        reviewerAgent: { uuid: reviewer.uuid, name: reviewer.name, displayName: reviewer.displayName },
      },
    });

    const disabled = await app.inject({
      method: "PUT",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { contextReviewer: { enabled: false, agentUuid: reviewer.uuid } },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toEqual({ contextReviewer: { enabled: false, agentUuid: null, reviewerAgent: null } });
  });

  it("member can GET source_repos and context_tree (readPolicy: member) but cannot PUT / DELETE", async () => {
    const app = getApp();
    const { admin, member } = await adminAndMember(app);

    for (const ns of ["source_repos", "context_tree"] as const) {
      const url = `/api/v1/orgs/${admin.organizationId}/settings/${ns}`;

      const get = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${member.accessToken}` },
      });
      expect(get.statusCode, `GET ${ns} should be 200 for member`).toBe(200);

      const put = await app.inject({
        method: "PUT",
        url,
        headers: { authorization: `Bearer ${member.accessToken}` },
        payload: ns === "source_repos" ? { repos: [] } : { branch: "x" },
      });
      expect(put.statusCode, `PUT ${ns} should be 403 for member`).toBe(403);

      const del = await app.inject({
        method: "DELETE",
        url,
        headers: { authorization: `Bearer ${member.accessToken}` },
      });
      expect(del.statusCode, `DELETE ${ns} should be 403 for member`).toBe(403);
    }
  });

  it("member can GET context_tree_features but cannot PUT or DELETE", async () => {
    const app = getApp();
    const { admin, member } = await adminAndMember(app);
    const reviewer = await createReviewerAgent(app, {
      managerId: admin.memberId,
      displayName: "Team Reviewer",
      name: `team-reviewer-${crypto.randomUUID().slice(0, 8)}`,
    });
    const url = `/api/v1/orgs/${admin.organizationId}/settings/context_tree_features`;

    await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree_features",
      { contextReviewer: { enabled: true, agentUuid: reviewer.uuid } },
      { updatedBy: admin.userId, memberId: admin.memberId },
    );

    const get = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({
      contextReviewer: {
        enabled: true,
        agentUuid: reviewer.uuid,
        reviewerAgent: { uuid: reviewer.uuid, name: reviewer.name, displayName: "Team Reviewer" },
      },
    });

    for (const method of ["PUT", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${member.accessToken}` },
        ...(method === "PUT" ? { payload: { contextReviewer: { enabled: false, agentUuid: null } } } : {}),
      });
      expect(res.statusCode, `${method} should be 403 for non-admin`).toBe(403);
    }
  });
});
