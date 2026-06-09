import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authIdentities } from "../db/schema/auth-identities.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { decryptValue, encryptValue } from "../services/crypto.js";
import { getOrgContextTree, putOrgSetting } from "../services/org-settings.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

type TestAdmin = Awaited<ReturnType<typeof createTestAdmin>>;
type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

const GITHUB_API_BASE = "https://api.github.com";
const TOKEN_URL = "https://github.com/login/oauth/access_token";

describe("POST /orgs/:orgId/context-tree/initialize", () => {
  const getApp = useTestApp();
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("creates a private GitHub repo, writes NODE.md, and persists context_tree", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedGithubIdentity(app, admin, { login: "octocat", accessToken: "ghu_live" });
    await app.db
      .update(organizations)
      .set({ displayName: "Acme Labs" })
      .where(eq(organizations.id, admin.organizationId));

    let createRepoPayload: unknown;
    let createFilePayload: unknown;
    mockFetch(async (url, init) => {
      if (url === `${GITHUB_API_BASE}/user/repos`) {
        expect(init?.headers).toEqual(expect.objectContaining({ Authorization: "Bearer ghu_live" }));
        createRepoPayload = parseJsonBody(init);
        return jsonResponse(
          {
            name: "acme-labs-context-tree",
            full_name: "octocat/acme-labs-context-tree",
            owner: { login: "octocat" },
            clone_url: "https://github.com/octocat/acme-labs-context-tree.git",
            html_url: "https://github.com/octocat/acme-labs-context-tree",
            private: true,
            default_branch: "main",
          },
          201,
        );
      }
      if (url === `${GITHUB_API_BASE}/repos/octocat/acme-labs-context-tree/contents/NODE.md`) {
        expect(init?.headers).toEqual(expect.objectContaining({ Authorization: "Bearer ghu_live" }));
        createFilePayload = parseJsonBody(init);
        return jsonResponse({ content: { path: "NODE.md" } }, 201);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/context-tree/initialize`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      repo: "https://github.com/octocat/acme-labs-context-tree.git",
      htmlUrl: "https://github.com/octocat/acme-labs-context-tree",
      branch: "main",
      nodePath: "NODE.md",
    });
    expect(createRepoPayload).toMatchObject({
      name: "acme-labs-context-tree",
      private: true,
      auto_init: false,
      description: "Acme Labs Context Tree",
    });
    expect(createFilePayload).toMatchObject({
      branch: "main",
      message: "Initialize Context Tree root node",
    });
    const nodeContent = readBase64Content(createFilePayload);
    expect(nodeContent).toBe(`---
title: "Acme Labs Context Tree"
description: "Shared context, decisions, ownership, and operating knowledge for Acme Labs."
owners: [octocat]
---

# Acme Labs's Context Tree
`);

    const setting = await getOrgContextTree(app.db, admin.organizationId);
    expect(setting).toEqual({ repo: "https://github.com/octocat/acme-labs-context-tree.git", branch: "main" });
  });

  it("returns 409 without calling GitHub when context_tree.repo already exists", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await putOrgSetting(
      app.db,
      admin.organizationId,
      "context_tree",
      { repo: "https://github.com/acme/existing-context-tree.git", branch: "main" },
      { updatedBy: admin.userId },
    );
    const fetchSpy = mockFetch(async () => new Response("unexpected", { status: 500 }));

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/context-tree/initialize`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects non-admin members before calling GitHub", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const member = await createTestAdmin(app);
    await app.db.update(members).set({ role: "member" }).where(eq(members.id, member.memberId));
    const fetchSpy = mockFetch(async () => new Response("unexpected", { status: 500 }));

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/context-tree/initialize`,
      headers: { authorization: `Bearer ${member.accessToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns an actionable auth error when GitHub credentials are missing", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/context-tree/initialize`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: string }>().error).toMatch(/reconnect/i);
  });

  it("maps GitHub repo-name conflicts to 409", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedGithubIdentity(app, admin, { login: "octocat", accessToken: "ghu_conflict" });
    const fetchSpy = mockFetch(async (url) => {
      if (url === `${GITHUB_API_BASE}/user/repos`) {
        return jsonResponse({ message: "Repository creation failed." }, 422);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/context-tree/initialize`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toMatch(/already exists/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refreshes an expired GitHub App user token before creating the repo", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedGithubIdentity(app, admin, {
      login: "octocat",
      accessToken: "old-access",
      accessTokenExpiresAt: "2000-01-01T00:00:00.000Z",
      refreshToken: "old-refresh",
      refreshTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    });

    mockFetch(async (url, init) => {
      if (url === TOKEN_URL) {
        expect(parseJsonBody(init)).toMatchObject({
          client_id: "test-app-client-id",
          client_secret: "test-app-client-secret",
          grant_type: "refresh_token",
          refresh_token: "old-refresh",
        });
        return jsonResponse({
          access_token: "new-access",
          expires_in: 28_800,
          refresh_token: "new-refresh",
          refresh_token_expires_in: 15_552_000,
          scope: "repo",
          token_type: "bearer",
        });
      }
      if (url === `${GITHUB_API_BASE}/user/repos`) {
        expect(init?.headers).toEqual(expect.objectContaining({ Authorization: "Bearer new-access" }));
        return jsonResponse(
          {
            name: "default-organization-context-tree",
            full_name: "octocat/default-organization-context-tree",
            owner: { login: "octocat" },
            clone_url: "https://github.com/octocat/default-organization-context-tree.git",
            html_url: "https://github.com/octocat/default-organization-context-tree",
            private: true,
            default_branch: "main",
          },
          201,
        );
      }
      if (url === `${GITHUB_API_BASE}/repos/octocat/default-organization-context-tree/contents/NODE.md`) {
        expect(init?.headers).toEqual(expect.objectContaining({ Authorization: "Bearer new-access" }));
        return jsonResponse({ content: { path: "NODE.md" } }, 201);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/context-tree/initialize`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    const [identity] = await app.db
      .select({ metadata: authIdentities.metadata })
      .from(authIdentities)
      .where(eq(authIdentities.userId, admin.userId))
      .limit(1);
    const metadata = requireRecord(identity?.metadata);
    expect(decryptValue(requireString(metadata, "accessToken"), app.config.secrets.encryptionKey)).toBe("new-access");
    expect(decryptValue(requireString(metadata, "refreshToken"), app.config.secrets.encryptionKey)).toBe("new-refresh");
  });
});

async function seedGithubIdentity(
  app: FastifyInstance,
  admin: TestAdmin,
  opts: {
    login: string;
    accessToken: string;
    accessTokenExpiresAt?: string;
    refreshToken?: string;
    refreshTokenExpiresAt?: string;
  },
): Promise<void> {
  const metadata: Record<string, unknown> = {
    login: opts.login,
    accessToken: encryptValue(opts.accessToken, app.config.secrets.encryptionKey),
  };
  if (opts.accessTokenExpiresAt) metadata.accessTokenExpiresAt = opts.accessTokenExpiresAt;
  if (opts.refreshToken) metadata.refreshToken = encryptValue(opts.refreshToken, app.config.secrets.encryptionKey);
  if (opts.refreshTokenExpiresAt) metadata.refreshTokenExpiresAt = opts.refreshTokenExpiresAt;

  await app.db.insert(authIdentities).values({
    id: uuidv7(),
    userId: admin.userId,
    provider: "github",
    identifier: "123456",
    email: `${opts.login}@example.test`,
    verifiedAt: new Date(),
    metadata,
  });
}

function mockFetch(handler: (url: string, init: FetchInit) => Promise<Response>) {
  const fetchSpy = vi.fn((input: FetchInput, init?: FetchInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  });
  globalThis.fetch = fetchSpy;
  return fetchSpy;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseJsonBody(init: FetchInit): unknown {
  if (!init || typeof init.body !== "string") {
    throw new Error("Expected JSON string body");
  }
  return JSON.parse(init.body);
}

function readBase64Content(value: unknown): string {
  const record = requireRecord(value);
  return Buffer.from(requireString(record, "content"), "base64").toString("utf8");
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Expected record");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Expected string field ${key}`);
  }
  return value;
}
