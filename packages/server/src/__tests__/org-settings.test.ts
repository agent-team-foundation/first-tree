import crypto, { createHmac, randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { members } from "../db/schema/members.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { organizations } from "../db/schema/organizations.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import { signTokensForUser } from "../services/auth.js";
import { isEncryptedValue } from "../services/crypto.js";
import * as orgSettingsService from "../services/org-settings.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, INVALID_BCRYPT_PLACEHOLDER, useTestApp } from "./helpers.js";

const TEST_JWT_SECRET = "test-jwt-secret-key-for-vitest";
// 32 bytes hex — matches the crypto.parseKey contract.
const TEST_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("org-settings service", () => {
  const getApp = useTestApp();

  it("getOrgSetting returns namespace defaults when no row exists", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const ct = await orgSettingsService.getOrgSetting(app.db, admin.organizationId, "context_tree");
    expect(ct).toEqual({ branch: "main" });

    const gh = await orgSettingsService.getOrgSetting(app.db, admin.organizationId, "github_integration");
    // webhookUrl is left as "" by the service; the route layer enriches it with publicUrl.
    expect(gh).toEqual({ webhookSecretConfigured: false, webhookUrl: "" });
  });

  it("putOrgSetting stores context_tree and round-trips via getOrgSetting", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const out = await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      { repo: "https://github.com/example/tree", branch: "main" },
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
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
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
    );

    // undefined `repo` leaves it intact; null `branch` clears (server falls back to "main").
    const after = await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      { branch: null },
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
    );
    expect(after).toEqual({ repo: "https://github.com/example/tree", branch: "main" });
  });

  it("putOrgSetting encrypts webhook secret at rest; getOrgSetting masks it", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const out = await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "github_integration",
      { webhookSecret: "super-secret-123" },
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
    );
    expect(out).toEqual({ webhookSecretConfigured: true, webhookUrl: "" });

    // Stored value never contains plaintext.
    const [row] = await app.db
      .select()
      .from(organizationSettings)
      .where(
        and(
          eq(organizationSettings.organizationId, admin.organizationId),
          eq(organizationSettings.namespace, "github_integration"),
        ),
      );
    expect(row).toBeDefined();
    const stored = row?.value as { webhookSecretCipher?: string };
    expect(stored.webhookSecretCipher).toBeDefined();
    expect(isEncryptedValue(stored.webhookSecretCipher ?? "")).toBe(true);
    expect(stored.webhookSecretCipher).not.toContain("super-secret");

    // Internal helper decrypts back to plaintext.
    const decrypted = await orgSettingsService.getDecryptedGithubWebhookSecret(
      app.db,
      admin.organizationId,
      TEST_ENCRYPTION_KEY,
    );
    expect(decrypted).toBe("super-secret-123");
  });

  it("putOrgSetting null webhookSecret clears the cipher", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "github_integration",
      { webhookSecret: "first" },
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
    );
    const cleared = await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "github_integration",
      { webhookSecret: null },
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
    );
    expect(cleared.webhookSecretConfigured).toBe(false);
  });

  it("rejects empty-string webhookSecret at the schema layer (#3)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    await expect(
      orgSettingsService.putOrgSetting(
        app.db,
        admin.organizationId,
        "github_integration",
        { webhookSecret: "" },
        { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
      ),
    ).rejects.toThrow();
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
        { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
      ),
    ).rejects.toThrow();
  });

  it("rejects non-HTTPS or credential-bearing Context Tree repo URLs", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const putRepo = (repo: string) =>
      orgSettingsService.putOrgSetting(
        app.db,
        admin.organizationId,
        "context_tree",
        { repo },
        { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
      );

    await expect(putRepo("ssh://git@github.com/example/tree.git")).rejects.toThrow();
    await expect(putRepo("https://user:secret@github.com/example/tree.git")).rejects.toThrow();
  });

  it("putOrgSetting bumps version on subsequent writes", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      { repo: "https://github.com/example/a" },
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
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
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
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
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
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
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
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
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
    );

    // No `repos` field in the PUT body — current list must survive.
    const after = await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "source_repos",
      {},
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
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
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
    );
    const cleared = await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "source_repos",
      { repos: [] },
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
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
        { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
      ),
    ).rejects.toThrow();
  });

  it("source_repos rejects http:// URLs (HTTPS-only)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await expect(
      orgSettingsService.putOrgSetting(
        app.db,
        admin.organizationId,
        "source_repos",
        { repos: [{ url: "http://github.com/example/insecure" }] },
        { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
      ),
    ).rejects.toThrow(/HTTPS/);
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
        { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
      ),
    ).rejects.toThrow(/credentials/);
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
        { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
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
      payload: { repo: "https://github.com/example/api", branch: "api" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ repo: "https://github.com/example/api", branch: "api" });

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

  it("context tree snapshot uses the org id from the route, not the caller's primary org", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const sideOrgId = await attachOrg(app, admin.userId);
    await orgSettingsService.putOrgSetting(
      app.db,
      sideOrgId,
      "context_tree",
      { repo: "https://github.com/example/current-team-context", branch: "--bad" },
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
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

    for (const method of ["PUT", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${member.accessToken}` },
        ...(method === "PUT" ? { payload: { branch: "x" } } : {}),
      });
      expect(res.statusCode, `${method} should be 403 for non-admin`).toBe(403);
    }
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

  it("PUT webhookSecret then GET returns masked output (no plaintext)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const url = `/api/v1/orgs/${admin.organizationId}/settings/github_integration`;

    const put = await app.inject({
      method: "PUT",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { webhookSecret: "do-not-leak-me" },
    });
    expect(put.statusCode).toBe(200);
    // webhookUrl is "" in tests because helpers.ts leaves server.publicUrl undefined.
    expect(put.json()).toEqual({ webhookSecretConfigured: true, webhookUrl: "" });
    expect(put.body).not.toContain("do-not-leak-me");

    const get = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(get.json()).toEqual({ webhookSecretConfigured: true, webhookUrl: "" });
    expect(get.body).not.toContain("do-not-leak-me");
  });

  it("admin can GET, PUT, DELETE source_repos via the generic route", async () => {
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
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ repos: [{ url: "https://github.com/example/api" }] });

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
    expect(get2.json()).toEqual({ repos: [] });
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

  it("member is still forbidden from GET github_integration (readPolicy: admin)", async () => {
    const app = getApp();
    const { admin, member } = await adminAndMember(app);
    const url = `/api/v1/orgs/${admin.organizationId}/settings/github_integration`;

    const res = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${member.accessToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("PUT empty-string webhookSecret returns 400 (#3)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/orgs/${admin.organizationId}/settings/github_integration`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { webhookSecret: "" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("github webhook end-to-end (per-org URL + signature)", () => {
  const getApp = useTestApp();

  it("POST /webhooks/github/:orgId with valid signature reaches the handler", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    // Configure a webhook secret for this org through the service layer.
    const SECRET = "e2e-webhook-secret";
    await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "github_integration",
      { webhookSecret: SECRET },
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
    );

    // Send a `ping` event — minimal payload that the handler short-circuits on.
    const body = JSON.stringify({ zen: "Practicality beats purity." });
    const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/github/${admin.organizationId}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "x-github-event": "ping",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, event: "ping" });
  });

  it("POST /webhooks/github/:orgId with bad signature returns 401", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "github_integration",
      { webhookSecret: "real-secret" },
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
    );

    const body = JSON.stringify({ zen: "x" });
    const wrongSignature = `sha256=${createHmac("sha256", "wrong-secret").update(body).digest("hex")}`;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/github/${admin.organizationId}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": wrongSignature,
        "x-github-event": "ping",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
  });

  it("POST /webhooks/github/:orgId returns 501 when secret never configured", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    // No webhookSecret put for this org — should fall through to 501.

    const body = JSON.stringify({ zen: "x" });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/github/${admin.organizationId}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${createHmac("sha256", "anything").update(body).digest("hex")}`,
        "x-github-event": "ping",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(501);
  });

  // Pins issue #283 — without idempotency, GitHub retries (and near-simultaneous
  // duplicate fires) produced duplicate fan-out into the routed chat.
  it("dedupes repeated x-github-delivery on side-effecting events", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const SECRET = "dedup-secret";
    await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "github_integration",
      { webhookSecret: SECRET },
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
    );

    // `push` is not in MENTION_ACTIONS, so the handler returns 200 without
    // fan-out — perfect for exercising the dedup gate in isolation.
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    const deliveryId = randomUUID();

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/github/${admin.organizationId}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "x-github-event": "push",
        "x-github-delivery": deliveryId,
      },
      payload: body,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, event: "push" });
    expect(first.json()).not.toHaveProperty("deduped");

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/github/${admin.organizationId}`,
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "x-github-event": "push",
        "x-github-delivery": deliveryId,
      },
      payload: body,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, event: "push", deduped: true });
  });

  // Regression guard: if someone deletes the `unclaimEvent` call in the
  // route handler's catch block, GitHub's retry of a failed delivery would
  // be permanently swallowed by the dedup gate (claim succeeds on attempt 1,
  // handler throws, claim stays held, retry returns `deduped: true` even
  // though the work was never done). This test pins the contract that an
  // erroring handler must release the slot.
  it("releases the dedup slot when the handler throws so GitHub retry can re-process", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const SECRET = "unclaim-secret";
    await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "github_integration",
      { webhookSecret: SECRET },
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
    );

    // Malformed `issues` payload — missing the `issue` / `repository` / `sender`
    // fields makes `parseIssuesPayload` throw `BadRequestError` deep inside
    // `handleIssuesEvent`, which exercises the catch-and-unclaim branch.
    const body = JSON.stringify({ action: "opened" });
    const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    const deliveryId = randomUUID();
    const headers = {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-github-event": "issues",
      "x-github-delivery": deliveryId,
    };

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/github/${admin.organizationId}`,
      headers,
      payload: body,
    });
    expect(first.statusCode).toBe(400);

    const retry = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/github/${admin.organizationId}`,
      headers,
      payload: body,
    });
    // If unclaim had not run, retry would be 200 with `{ deduped: true }`.
    expect(retry.statusCode).toBe(400);
    expect(retry.json()).not.toMatchObject({ deduped: true });
  });

  it("ping events bypass the idempotency table", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const SECRET = "ping-secret";
    await orgSettingsService.putOrgSetting(
      app.db,
      admin.organizationId,
      "github_integration",
      { webhookSecret: SECRET },
      { updatedBy: admin.userId, encryptionKey: TEST_ENCRYPTION_KEY },
    );

    const body = JSON.stringify({ zen: "x" });
    const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    const deliveryId = randomUUID();
    const headers = {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-github-event": "ping",
      "x-github-delivery": deliveryId,
    };

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/github/${admin.organizationId}`,
      headers,
      payload: body,
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/v1/webhooks/github/${admin.organizationId}`,
      headers,
      payload: body,
    });

    expect(first.json()).toEqual({ ok: true, event: "ping" });
    expect(second.json()).toEqual({ ok: true, event: "ping" });
  });
});
