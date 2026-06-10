import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authIdentities } from "../db/schema/auth-identities.js";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { encryptValue } from "../services/crypto.js";
import { bindInstallationToOrg, upsertInstallationFromMetadata } from "../services/github-app-installations.js";
import { getOrgContextTree, putOrgSetting } from "../services/org-settings.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

type TestAdmin = Awaited<ReturnType<typeof createTestAdmin>>;
type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

const GITHUB_API_BASE = "https://api.github.com";
const INSTALLATION_TOKEN = "ghs_installation_token";
const ACCOUNT_LOGIN = "acme-github";
const REPO_NAME = "acme-labs-context-tree";
const CLONE_URL = `https://github.com/${ACCOUNT_LOGIN}/${REPO_NAME}.git`;
const HTML_URL = `https://github.com/${ACCOUNT_LOGIN}/${REPO_NAME}`;

const { privateKey: githubAppPrivateKeyPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

let nextInstallationId = 910_000;

describe("POST /orgs/:orgId/context-tree/initialize", () => {
  const getApp = useTestApp({ githubAppPrivateKeyPem });
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("creates an organization repo with the bound installation token, writes NODE.md, and persists context_tree", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    await renameOrg(app, admin.organizationId, "Acme Labs");

    let createRepoPayload: unknown;
    let createFilePayload: unknown;
    const fetchSpy = mockFetch(async (url, init) => {
      if (url === installationTokenUrl(installationId)) {
        expectAuth(init, "Bearer");
        return installationTokenResponse();
      }
      if (url === orgReposUrl(ACCOUNT_LOGIN)) {
        expectAuth(init, `Bearer ${INSTALLATION_TOKEN}`);
        createRepoPayload = parseJsonBody(init);
        return githubRepoResponse(201);
      }
      if (url === repoUrl(ACCOUNT_LOGIN, REPO_NAME)) {
        expectAuth(init, `Bearer ${INSTALLATION_TOKEN}`);
        return githubRepoResponse(200);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, "NODE.md", "main")) {
        expectAuth(init, `Bearer ${INSTALLATION_TOKEN}`);
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, "NODE.md")) {
        expectAuth(init, `Bearer ${INSTALLATION_TOKEN}`);
        createFilePayload = parseJsonBody(init);
        return jsonResponse({ content: { path: "NODE.md" } }, 201);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      repo: CLONE_URL,
      htmlUrl: HTML_URL,
      branch: "main",
      nodePath: "NODE.md",
    });
    expect(createRepoPayload).toMatchObject({
      name: REPO_NAME,
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
owners: [${ACCOUNT_LOGIN}]
---

# Acme Labs's Context Tree
`);
    expect(fetchSpy).toHaveBeenCalledTimes(5);

    const setting = await getOrgContextTree(app.db, admin.organizationId);
    expect(setting).toEqual({ repo: CLONE_URL, branch: "main" });
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

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects non-admin members before calling GitHub", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const member = await createTestAdmin(app);
    await app.db
      .update(members)
      .set({ organizationId: admin.organizationId, role: "member" })
      .where(eq(members.id, member.memberId));
    const fetchSpy = mockFetch(async () => new Response("unexpected", { status: 500 }));

    const res = await initialize(app, { ...admin, accessToken: member.accessToken });

    expect(res.statusCode).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 503 no_installation without calling GitHub when no installation is bound", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const fetchSpy = mockFetch(async () => new Response("unexpected", { status: 500 }));

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "no_installation" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 503 not_configured without calling GitHub when server GitHub App config is missing", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedInstallation(app, admin.organizationId);
    const fetchSpy = mockFetch(async () => new Response("unexpected", { status: 500 }));
    const originalOauth = app.config.oauth;
    app.config.oauth = undefined;
    try {
      const res = await initialize(app, admin);

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "not_configured" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      app.config.oauth = originalOauth;
    }
  });

  it("does not fall back to the signed-in user's GitHub token when the installation is bound elsewhere", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const otherOrganizationId = await createOrganization(app, "other-github-team");
    await seedGithubIdentity(app, admin, { login: "octocat", accessToken: "ghu_personal" });
    await seedInstallation(app, otherOrganizationId, { accountLogin: "octocat" });
    const fetchSpy = mockFetch(async (url) => {
      if (url === `${GITHUB_API_BASE}/user/repos`) {
        return githubRepoResponse(201, { owner: "octocat", name: "personal-context-tree" });
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "no_installation" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await getOrgContextTree(app.db, admin.organizationId)).repo).toBeUndefined();
  });

  it("returns 503 suspended when the bound installation is suspended", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedInstallation(app, admin.organizationId, { suspendedAt: "2026-05-11T10:00:00Z" });
    const fetchSpy = mockFetch(async () => new Response("unexpected", { status: 500 }));

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "suspended" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns 502 upstream when installation-token minting fails", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    const fetchSpy = mockFetch(async (url) => {
      if (url === installationTokenUrl(installationId)) {
        return jsonResponse({ message: "Bad credentials" }, 401);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "upstream" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns 409 selected_repositories_unsupported before creating anything", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    const fetchSpy = mockFetch(async (url) => {
      if (url === installationTokenUrl(installationId)) {
        return installationTokenResponse({ repository_selection: "selected" });
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "selected_repositories_unsupported" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  const permissionCases: Array<[string, Record<string, "read" | "write" | "admin">]> = [
    ["administration", { administration: "read", contents: "write" }],
    ["contents", { administration: "write", contents: "read" }],
  ];
  for (const [missingPermission, permissions] of permissionCases) {
    it(`returns 403 installation_permissions_insufficient when ${missingPermission} is not write`, async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const installationId = await seedInstallation(app, admin.organizationId);
      const fetchSpy = mockFetch(async (url) => {
        if (url === installationTokenUrl(installationId)) {
          return installationTokenResponse({ permissions });
        }
        return new Response(`unexpected fetch ${url}`, { status: 500 });
      });

      const res = await initialize(app, admin);

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "installation_permissions_insufficient" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  }

  it("adopts an existing deterministic repo when create returns 422 and the installation can read it", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    await renameOrg(app, admin.organizationId, "Acme Labs");
    let fileWrites = 0;
    const fetchSpy = mockFetch(async (url) => {
      if (url === installationTokenUrl(installationId)) return installationTokenResponse();
      if (url === orgReposUrl(ACCOUNT_LOGIN)) return jsonResponse({ message: "Repository creation failed." }, 422);
      if (url === repoUrl(ACCOUNT_LOGIN, REPO_NAME)) return githubRepoResponse(200);
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, "NODE.md", "main")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, "NODE.md")) {
        fileWrites += 1;
        return jsonResponse({ content: { path: "NODE.md" } }, 201);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(201);
    expect(fileWrites).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(await getOrgContextTree(app.db, admin.organizationId)).toEqual({ repo: CLONE_URL, branch: "main" });
  });

  it("returns 409 repo_unavailable when an existing deterministic repo is not readable by the installation", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    await renameOrg(app, admin.organizationId, "Acme Labs");
    const fetchSpy = mockFetch(async (url) => {
      if (url === installationTokenUrl(installationId)) return installationTokenResponse();
      if (url === orgReposUrl(ACCOUNT_LOGIN)) return jsonResponse({ message: "Repository creation failed." }, 422);
      if (url === repoUrl(ACCOUNT_LOGIN, REPO_NAME)) return jsonResponse({ message: "Not Found" }, 404);
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "repo_unavailable" });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect((await getOrgContextTree(app.db, admin.organizationId)).repo).toBeUndefined();
  });

  it("adopts an existing repo with an existing NODE.md without rewriting the file", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    await renameOrg(app, admin.organizationId, "Acme Labs");
    let fileWrites = 0;
    const fetchSpy = mockFetch(async (url) => {
      if (url === installationTokenUrl(installationId)) return installationTokenResponse();
      if (url === orgReposUrl(ACCOUNT_LOGIN)) return jsonResponse({ message: "Repository creation failed." }, 422);
      if (url === repoUrl(ACCOUNT_LOGIN, REPO_NAME)) return githubRepoResponse(200);
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, "NODE.md", "main")) {
        return jsonResponse({ path: "NODE.md" }, 200);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, "NODE.md")) {
        fileWrites += 1;
        return jsonResponse({ content: { path: "NODE.md" } }, 201);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(201);
    expect(fileWrites).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(await getOrgContextTree(app.db, admin.organizationId)).toEqual({ repo: CLONE_URL, branch: "main" });
  });

  it("can retry successfully when the root-node write failed after repo creation", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    await renameOrg(app, admin.organizationId, "Acme Labs");
    let repoCreateCalls = 0;
    let fileWriteCalls = 0;
    mockFetch(async (url) => {
      if (url === installationTokenUrl(installationId)) return installationTokenResponse();
      if (url === orgReposUrl(ACCOUNT_LOGIN)) {
        repoCreateCalls += 1;
        return repoCreateCalls === 1
          ? githubRepoResponse(201)
          : jsonResponse({ message: "Repository creation failed." }, 422);
      }
      if (url === repoUrl(ACCOUNT_LOGIN, REPO_NAME)) return githubRepoResponse(200);
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, "NODE.md", "main")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, "NODE.md")) {
        fileWriteCalls += 1;
        return fileWriteCalls === 1
          ? jsonResponse({ message: "GitHub unavailable" }, 500)
          : jsonResponse({ content: { path: "NODE.md" } }, 201);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const first = await initialize(app, admin);
    expect(first.statusCode).toBe(502);
    expect(first.json()).toMatchObject({ code: "upstream" });
    expect((await getOrgContextTree(app.db, admin.organizationId)).repo).toBeUndefined();

    const second = await initialize(app, admin);
    expect(second.statusCode).toBe(201);
    expect(repoCreateCalls).toBe(2);
    expect(fileWriteCalls).toBe(2);
    expect(await getOrgContextTree(app.db, admin.organizationId)).toEqual({ repo: CLONE_URL, branch: "main" });
  });

  it("can retry successfully when DB save failed after repo creation and root-node write", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    await renameOrg(app, admin.organizationId, "Acme Labs");
    let repoCreateCalls = 0;
    let rootNodeExists = false;
    vi.spyOn(app.db, "transaction").mockRejectedValueOnce(new Error("db down"));
    mockFetch(async (url) => {
      if (url === installationTokenUrl(installationId)) return installationTokenResponse();
      if (url === orgReposUrl(ACCOUNT_LOGIN)) {
        repoCreateCalls += 1;
        return repoCreateCalls === 1
          ? githubRepoResponse(201)
          : jsonResponse({ message: "Repository creation failed." }, 422);
      }
      if (url === repoUrl(ACCOUNT_LOGIN, REPO_NAME)) return githubRepoResponse(200);
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, "NODE.md", "main")) {
        return rootNodeExists ? jsonResponse({ path: "NODE.md" }, 200) : jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, "NODE.md")) {
        rootNodeExists = true;
        return jsonResponse({ content: { path: "NODE.md" } }, 201);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const first = await initialize(app, admin);
    expect(first.statusCode).toBe(500);
    expect(rootNodeExists).toBe(true);
    expect((await getOrgContextTree(app.db, admin.organizationId)).repo).toBeUndefined();

    const second = await initialize(app, admin);
    expect(second.statusCode).toBe(201);
    expect(repoCreateCalls).toBe(2);
    expect(await getOrgContextTree(app.db, admin.organizationId)).toEqual({ repo: CLONE_URL, branch: "main" });
  });
});

async function initialize(app: FastifyInstance, admin: Pick<TestAdmin, "organizationId" | "accessToken">) {
  return app.inject({
    method: "POST",
    url: `/api/v1/orgs/${admin.organizationId}/context-tree/initialize`,
    headers: { authorization: `Bearer ${admin.accessToken}` },
    payload: {},
  });
}

async function renameOrg(app: FastifyInstance, organizationId: string, displayName: string): Promise<void> {
  await app.db.update(organizations).set({ displayName }).where(eq(organizations.id, organizationId));
}

async function createOrganization(app: FastifyInstance, name: string): Promise<string> {
  const id = uuidv7();
  await app.db.insert(organizations).values({ id, name, displayName: name });
  return id;
}

async function seedInstallation(
  app: FastifyInstance,
  organizationId: string,
  opts: {
    accountLogin?: string;
    accountType?: "User" | "Organization";
    permissions?: Record<string, "read" | "write" | "admin">;
    repositoryEvents?: string[];
    suspendedAt?: string | null;
  } = {},
): Promise<number> {
  const installationId = nextInstallationId;
  nextInstallationId += 1;
  await upsertInstallationFromMetadata(app.db, {
    installation: {
      id: installationId,
      accountType: opts.accountType ?? "Organization",
      accountLogin: opts.accountLogin ?? ACCOUNT_LOGIN,
      accountGithubId: installationId + 1_000_000,
      permissions: opts.permissions ?? { administration: "write", contents: "write" },
      events: opts.repositoryEvents ?? ["push"],
      suspendedAt: opts.suspendedAt ?? null,
    },
  });
  await bindInstallationToOrg(app.db, installationId, organizationId);
  return installationId;
}

async function seedGithubIdentity(
  app: FastifyInstance,
  admin: TestAdmin,
  opts: {
    login: string;
    accessToken: string;
  },
): Promise<void> {
  await app.db.insert(authIdentities).values({
    id: uuidv7(),
    userId: admin.userId,
    provider: "github",
    identifier: "123456",
    email: `${opts.login}@example.test`,
    verifiedAt: new Date(),
    metadata: {
      login: opts.login,
      accessToken: encryptValue(opts.accessToken, app.config.secrets.encryptionKey),
    },
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

function installationTokenResponse(
  overrides: {
    permissions?: Record<string, "read" | "write" | "admin">;
    repository_selection?: "all" | "selected";
  } = {},
): Response {
  return jsonResponse(
    {
      token: INSTALLATION_TOKEN,
      expires_at: "2026-05-15T01:00:00Z",
      permissions: overrides.permissions ?? { administration: "write", contents: "write" },
      repository_selection: overrides.repository_selection ?? "all",
    },
    201,
  );
}

function githubRepoResponse(
  status: number,
  overrides: { owner?: string; name?: string; private?: boolean } = {},
): Response {
  const owner = overrides.owner ?? ACCOUNT_LOGIN;
  const name = overrides.name ?? REPO_NAME;
  return jsonResponse(
    {
      name,
      full_name: `${owner}/${name}`,
      owner: { login: owner },
      clone_url: `https://github.com/${owner}/${name}.git`,
      html_url: `https://github.com/${owner}/${name}`,
      private: overrides.private ?? true,
      default_branch: "main",
    },
    status,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installationTokenUrl(installationId: number): string {
  return `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`;
}

function orgReposUrl(org: string): string {
  return `${GITHUB_API_BASE}/orgs/${encodeURIComponent(org)}/repos`;
}

function repoUrl(owner: string, repo: string): string {
  return `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function contentsUrl(owner: string, repo: string, path: string, branch?: string): string {
  const base = `${repoUrl(owner, repo)}/contents/${encodePath(path)}`;
  return branch ? `${base}?ref=${encodeURIComponent(branch)}` : base;
}

function expectAuth(init: FetchInit, expectedAuthorization: string): void {
  const headers = new Headers(init?.headers);
  const actual = headers.get("authorization");
  if (expectedAuthorization === "Bearer") {
    expect(actual?.startsWith("Bearer ")).toBe(true);
    return;
  }
  expect(actual).toBe(expectedAuthorization);
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

function encodePath(path: string): string {
  return path
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
}
