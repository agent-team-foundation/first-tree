import { generateKeyPairSync } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authIdentities } from "../db/schema/auth-identities.js";
import { members } from "../db/schema/members.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { organizations } from "../db/schema/organizations.js";
import { encryptValue } from "../services/crypto.js";
import { bindInstallationToOrg, upsertInstallationFromMetadata } from "../services/github-app-installations.js";
import { getOrgContextTreeBinding, getOrgSetting, putOrgSetting } from "../services/org-settings.js";
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
const USER_LOGIN = "octocat";
const USER_GITHUB_ID = 4242;
const USER_REPO_CLONE_URL = `https://github.com/${USER_LOGIN}/${REPO_NAME}.git`;
const ROOT_NODE_PATH = "NODE.md";
const VALIDATE_TREE_WORKFLOW_PATH = ".github/workflows/validate-tree.yml";
const VALIDATE_TREE_WORKFLOW_CONTENT = `name: Validate Context Tree

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Validate Context Tree
        run: npx -p first-tree first-tree tree verify
`;

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

  it("creates an organization repo with the bound installation token, writes NODE.md and the validation workflow, and persists context_tree", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    await renameOrg(app, admin.organizationId, "Acme Labs");

    let createRepoPayload: unknown;
    let createRootNodePayload: unknown;
    let createWorkflowPayload: unknown;
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
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH, "main")) {
        expectAuth(init, `Bearer ${INSTALLATION_TOKEN}`);
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH)) {
        expectAuth(init, `Bearer ${INSTALLATION_TOKEN}`);
        createRootNodePayload = parseJsonBody(init);
        return jsonResponse({ content: { path: ROOT_NODE_PATH } }, 201);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH, "main")) {
        expectAuth(init, `Bearer ${INSTALLATION_TOKEN}`);
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH)) {
        expectAuth(init, `Bearer ${INSTALLATION_TOKEN}`);
        createWorkflowPayload = parseJsonBody(init);
        return jsonResponse({ content: { path: VALIDATE_TREE_WORKFLOW_PATH } }, 201);
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
    expect(createRootNodePayload).toMatchObject({
      branch: "main",
      message: "Initialize Context Tree root node",
    });
    const nodeContent = readBase64Content(createRootNodePayload);
    expect(nodeContent).toBe(`---
title: "Acme Labs Context Tree"
description: "Shared context, decisions, ownership, and operating knowledge for Acme Labs."
owners: [${ACCOUNT_LOGIN}]
---

# Acme Labs's Context Tree
`);
    expect(createWorkflowPayload).toMatchObject({
      branch: "main",
      message: "Initialize Context Tree validation workflow",
    });
    expect(readBase64Content(createWorkflowPayload)).toBe(VALIDATE_TREE_WORKFLOW_CONTENT);
    expect(fetchSpy).toHaveBeenCalledTimes(7);

    const setting = await getOrgContextTreeBinding(app.db, admin.organizationId);
    expect(setting).toEqual({ provider: "github", repo: CLONE_URL, branch: "main" });
  });

  it("does not let initialize overwrite a binding committed after its absent precheck", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    await renameOrg(app, admin.organizationId, "Acme Labs");

    const setterBinding = {
      provider: "github" as const,
      repo: "https://github.com/example/setter-context-tree.git",
      branch: "setter-branch",
    };
    const workflowPutReached = deferred();
    const releaseWorkflowPut = deferred();
    let workflowPutCalls = 0;
    const fetchSpy = mockFetch(async (url, init) => {
      if (url === installationTokenUrl(installationId)) {
        expectAuth(init, "Bearer");
        return installationTokenResponse();
      }
      if (url === orgReposUrl(ACCOUNT_LOGIN)) {
        expectAuth(init, `Bearer ${INSTALLATION_TOKEN}`);
        return githubRepoResponse(201);
      }
      if (url === repoUrl(ACCOUNT_LOGIN, REPO_NAME)) {
        expectAuth(init, `Bearer ${INSTALLATION_TOKEN}`);
        return githubRepoResponse(200);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH, "main")) {
        expectAuth(init, `Bearer ${INSTALLATION_TOKEN}`);
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH)) {
        expectAuth(init, `Bearer ${INSTALLATION_TOKEN}`);
        return jsonResponse({ content: { path: ROOT_NODE_PATH } }, 201);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH, "main")) {
        expectAuth(init, `Bearer ${INSTALLATION_TOKEN}`);
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH)) {
        expectAuth(init, `Bearer ${INSTALLATION_TOKEN}`);
        parseJsonBody(init);
        workflowPutCalls += 1;
        // Reaching this handler represents the final GitHub side effect. Keep
        // initialize suspended until the competing settings PUT has committed.
        workflowPutReached.resolve();
        await releaseWorkflowPut.promise;
        return jsonResponse({ content: { path: VALIDATE_TREE_WORKFLOW_PATH } }, 201);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const initializePromise = initialize(app, admin);
    try {
      // The workflow PUT occurs only after initialize has completed its initial
      // absent-binding check and all earlier GitHub side effects.
      await Promise.race([
        workflowPutReached.promise,
        initializePromise.then((response) => {
          throw new Error(
            `initialize completed before the workflow barrier (${response.statusCode}): ${response.body}`,
          );
        }),
      ]);

      const setter = await app.inject({
        method: "PUT",
        url: `/api/v1/orgs/${admin.organizationId}/settings/context_tree`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        payload: setterBinding,
      });
      expect(setter.statusCode).toBe(200);
      expect(setter.json()).toEqual(setterBinding);

      releaseWorkflowPut.resolve();
      const initialized = await initializePromise;
      expect(initialized.statusCode).toBe(409);
      expect(initialized.json()).toMatchObject({
        error: "Context Tree setting changed after tree initialization began",
      });
      expect(workflowPutCalls).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(7);

      await expect(getOrgContextTreeBinding(app.db, admin.organizationId)).resolves.toEqual(setterBinding);
      const [row] = await app.db
        .select({ value: organizationSettings.value, version: organizationSettings.version })
        .from(organizationSettings)
        .where(
          and(
            eq(organizationSettings.organizationId, admin.organizationId),
            eq(organizationSettings.namespace, "context_tree"),
          ),
        );
      expect(row).toEqual({ value: setterBinding, version: 1 });
    } finally {
      releaseWorkflowPut.resolve();
      await initializePromise.catch(() => undefined);
    }
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

  it("returns 409 without overwriting an invalid historical Context Tree row", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await app.db.insert(organizationSettings).values({
      organizationId: admin.organizationId,
      namespace: "context_tree",
      value: { repo: "http://legacy.example/context-tree.git", branch: "bad..branch" },
      version: 1,
      updatedBy: admin.userId,
    });
    const fetchSpy = mockFetch(async () => new Response("unexpected", { status: 500 }));

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(getOrgSetting(app.db, admin.organizationId, "context_tree")).resolves.toEqual({
      repo: "http://legacy.example/context-tree.git",
      branch: "bad..branch",
    });
  });

  it("returns 409 before GitHub calls for a repo-less row with an invalid branch", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await app.db.insert(organizationSettings).values({
      organizationId: admin.organizationId,
      namespace: "context_tree",
      value: { branch: "--bad" },
      version: 1,
      updatedBy: admin.userId,
    });
    const fetchSpy = mockFetch(async () => new Response("unexpected", { status: 500 }));

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(getOrgSetting(app.db, admin.organizationId, "context_tree")).resolves.toEqual({ branch: "--bad" });
  });

  it("returns 409 before GitHub calls for a JSON null Context Tree row", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await app.db.insert(organizationSettings).values({
      organizationId: admin.organizationId,
      namespace: "context_tree",
      value: { branch: "main" },
      version: 1,
      updatedBy: admin.userId,
    });
    await app.db.execute(sql`
      UPDATE ${organizationSettings}
      SET value = 'null'::jsonb
      WHERE ${organizationSettings.organizationId} = ${admin.organizationId}
        AND ${organizationSettings.namespace} = 'context_tree'
    `);
    const fetchSpy = mockFetch(async () => new Response("unexpected", { status: 500 }));

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(409);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(getOrgContextTreeBinding(app.db, admin.organizationId)).resolves.toBeNull();
  });

  it("returns 409 without overwriting a binding committed after initialization side effects", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    await renameOrg(app, admin.organizationId, "Acme Labs");
    const concurrentBinding = {
      provider: "github" as const,
      repo: "https://github.com/example/manual-context-tree.git",
      branch: "manual",
    };
    let concurrentWriteDone = false;
    const fetchSpy = mockFetch(async (url) => {
      if (url === installationTokenUrl(installationId)) return installationTokenResponse();
      if (url === orgReposUrl(ACCOUNT_LOGIN)) return githubRepoResponse(201);
      if (url === repoUrl(ACCOUNT_LOGIN, REPO_NAME)) return githubRepoResponse(200);
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH, "main")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH)) {
        return jsonResponse({ content: { path: ROOT_NODE_PATH } }, 201);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH, "main")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH)) {
        if (!concurrentWriteDone) {
          concurrentWriteDone = true;
          await putOrgSetting(app.db, admin.organizationId, "context_tree", concurrentBinding, {
            updatedBy: admin.userId,
          });
        }
        return jsonResponse({ content: { path: VALIDATE_TREE_WORKFLOW_PATH } }, 201);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(409);
    expect(concurrentWriteDone).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(7);
    await expect(getOrgContextTreeBinding(app.db, admin.organizationId)).resolves.toEqual(concurrentBinding);
  });

  it("revalidates current Admin authority after GitHub side effects before committing the binding", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    await renameOrg(app, admin.organizationId, "Acme Labs");
    let roleRevoked = false;
    const fetchSpy = mockFetch(async (url) => {
      if (url === installationTokenUrl(installationId)) return installationTokenResponse();
      if (url === orgReposUrl(ACCOUNT_LOGIN)) return githubRepoResponse(201);
      if (url === repoUrl(ACCOUNT_LOGIN, REPO_NAME)) return githubRepoResponse(200);
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH, "main")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH)) {
        return jsonResponse({ content: { path: ROOT_NODE_PATH } }, 201);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH, "main")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH)) {
        await app.db.update(members).set({ role: "member" }).where(eq(members.id, admin.memberId));
        roleRevoked = true;
        return jsonResponse({ content: { path: VALIDATE_TREE_WORKFLOW_PATH } }, 201);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(403);
    expect(roleRevoked).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(7);
    await expect(getOrgContextTreeBinding(app.db, admin.organizationId)).resolves.toBeNull();
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
    expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toBeNull();
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

  it("initializes a Context Tree when the installation is scoped to selected repositories but can access the tree repo", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    await renameOrg(app, admin.organizationId, "Acme Labs");
    let rootNodeWrites = 0;
    let workflowWrites = 0;
    const fetchSpy = mockFetch(async (url) => {
      if (url === installationTokenUrl(installationId)) {
        return installationTokenResponse({ repository_selection: "selected" });
      }
      if (url === orgReposUrl(ACCOUNT_LOGIN)) return githubRepoResponse(201);
      if (url === repoUrl(ACCOUNT_LOGIN, REPO_NAME)) return githubRepoResponse(200);
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH, "main")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH)) {
        rootNodeWrites += 1;
        return jsonResponse({ content: { path: ROOT_NODE_PATH } }, 201);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH, "main")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH)) {
        workflowWrites += 1;
        return jsonResponse({ content: { path: VALIDATE_TREE_WORKFLOW_PATH } }, 201);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(201);
    expect(rootNodeWrites).toBe(1);
    expect(workflowWrites).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(7);
    expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toEqual({
      provider: "github",
      repo: CLONE_URL,
      branch: "main",
    });
  });

  it("returns 409 repo_unavailable when GitHub refuses to create the tree repo for the installation", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    await renameOrg(app, admin.organizationId, "Acme Labs");
    const fetchSpy = mockFetch(async (url) => {
      if (url === installationTokenUrl(installationId)) {
        return installationTokenResponse({ repository_selection: "selected" });
      }
      if (url === orgReposUrl(ACCOUNT_LOGIN)) {
        return jsonResponse({ message: "Resource not accessible by integration" }, 403);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "repo_unavailable" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toBeNull();
  });

  const permissionCases: Array<[string, Record<string, "read" | "write" | "admin">]> = [
    ["administration", { administration: "read", contents: "write", workflows: "write" }],
    ["contents", { administration: "write", contents: "read", workflows: "write" }],
    ["workflows", { administration: "write", contents: "write", workflows: "read" }],
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
    let rootNodeWrites = 0;
    let workflowWrites = 0;
    const fetchSpy = mockFetch(async (url) => {
      if (url === installationTokenUrl(installationId)) return installationTokenResponse();
      if (url === orgReposUrl(ACCOUNT_LOGIN)) return jsonResponse({ message: "Repository creation failed." }, 422);
      if (url === repoUrl(ACCOUNT_LOGIN, REPO_NAME)) return githubRepoResponse(200);
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH, "main")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH)) {
        rootNodeWrites += 1;
        return jsonResponse({ content: { path: ROOT_NODE_PATH } }, 201);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH, "main")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH)) {
        workflowWrites += 1;
        return jsonResponse({ content: { path: VALIDATE_TREE_WORKFLOW_PATH } }, 201);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(201);
    expect(rootNodeWrites).toBe(1);
    expect(workflowWrites).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(7);
    expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toEqual({
      provider: "github",
      repo: CLONE_URL,
      branch: "main",
    });
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
    expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toBeNull();
  });

  it("adopts an existing repo with an existing NODE.md without rewriting it and writes the missing workflow", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    await renameOrg(app, admin.organizationId, "Acme Labs");
    let rootNodeWrites = 0;
    let workflowWrites = 0;
    const fetchSpy = mockFetch(async (url) => {
      if (url === installationTokenUrl(installationId)) return installationTokenResponse();
      if (url === orgReposUrl(ACCOUNT_LOGIN)) return jsonResponse({ message: "Repository creation failed." }, 422);
      if (url === repoUrl(ACCOUNT_LOGIN, REPO_NAME)) return githubRepoResponse(200);
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH, "main")) {
        return jsonResponse({ path: ROOT_NODE_PATH }, 200);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH)) {
        rootNodeWrites += 1;
        return jsonResponse({ content: { path: ROOT_NODE_PATH } }, 201);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH, "main")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH)) {
        workflowWrites += 1;
        return jsonResponse({ content: { path: VALIDATE_TREE_WORKFLOW_PATH } }, 201);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(201);
    expect(rootNodeWrites).toBe(0);
    expect(workflowWrites).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(6);
    expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toEqual({
      provider: "github",
      repo: CLONE_URL,
      branch: "main",
    });
  });

  it("adopts an existing repo with an existing validation workflow without rewriting it", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    await renameOrg(app, admin.organizationId, "Acme Labs");
    let fileWrites = 0;
    const fetchSpy = mockFetch(async (url) => {
      if (url === installationTokenUrl(installationId)) return installationTokenResponse();
      if (url === orgReposUrl(ACCOUNT_LOGIN)) return jsonResponse({ message: "Repository creation failed." }, 422);
      if (url === repoUrl(ACCOUNT_LOGIN, REPO_NAME)) return githubRepoResponse(200);
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH, "main")) {
        return jsonResponse({ path: ROOT_NODE_PATH }, 200);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH, "main")) {
        return jsonResponse({ path: VALIDATE_TREE_WORKFLOW_PATH }, 200);
      }
      if (
        url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH) ||
        url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH)
      ) {
        fileWrites += 1;
        return jsonResponse({ content: { path: ROOT_NODE_PATH } }, 201);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(201);
    expect(fileWrites).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toEqual({
      provider: "github",
      repo: CLONE_URL,
      branch: "main",
    });
  });

  it("returns 502 and does not persist context_tree when the validation workflow write fails", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    await renameOrg(app, admin.organizationId, "Acme Labs");
    const fetchSpy = mockFetch(async (url) => {
      if (url === installationTokenUrl(installationId)) return installationTokenResponse();
      if (url === orgReposUrl(ACCOUNT_LOGIN)) return githubRepoResponse(201);
      if (url === repoUrl(ACCOUNT_LOGIN, REPO_NAME)) return githubRepoResponse(200);
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH, "main")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH)) {
        return jsonResponse({ content: { path: ROOT_NODE_PATH } }, 201);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH, "main")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH)) {
        return jsonResponse({ message: "GitHub unavailable" }, 500);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "upstream" });
    expect(fetchSpy).toHaveBeenCalledTimes(7);
    expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toBeNull();
  });

  it("returns repo_unavailable when the installation loses access before writing NODE.md", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    await renameOrg(app, admin.organizationId, "Acme Labs");
    const fetchSpy = mockFetch(async (url) => {
      if (url === installationTokenUrl(installationId)) return installationTokenResponse();
      if (url === orgReposUrl(ACCOUNT_LOGIN)) return githubRepoResponse(201);
      if (url === repoUrl(ACCOUNT_LOGIN, REPO_NAME)) return githubRepoResponse(200);
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH, "main")) {
        return jsonResponse({ message: "Resource not accessible by integration" }, 403);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "repo_unavailable" });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toBeNull();
  });

  it("returns repo_unavailable when validation workflow creation loses installation access", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    await renameOrg(app, admin.organizationId, "Acme Labs");
    const fetchSpy = mockFetch(async (url) => {
      if (url === installationTokenUrl(installationId)) return installationTokenResponse();
      if (url === orgReposUrl(ACCOUNT_LOGIN)) return githubRepoResponse(201);
      if (url === repoUrl(ACCOUNT_LOGIN, REPO_NAME)) return githubRepoResponse(200);
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH, "main")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH)) {
        return jsonResponse({ content: { path: ROOT_NODE_PATH } }, 201);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH, "main")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH)) {
        return jsonResponse({ message: "Resource not accessible by integration" }, 403);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const res = await initialize(app, admin);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "repo_unavailable" });
    expect(fetchSpy).toHaveBeenCalledTimes(7);
    expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toBeNull();
  });

  for (const createConflictStatus of [409, 422]) {
    it(`initializes successfully when validation workflow create returns ${createConflictStatus} and the file now exists`, async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const installationId = await seedInstallation(app, admin.organizationId);
      await renameOrg(app, admin.organizationId, "Acme Labs");
      let workflowReadCalls = 0;
      let workflowCreateCalls = 0;
      const fetchSpy = mockFetch(async (url) => {
        if (url === installationTokenUrl(installationId)) return installationTokenResponse();
        if (url === orgReposUrl(ACCOUNT_LOGIN)) return githubRepoResponse(201);
        if (url === repoUrl(ACCOUNT_LOGIN, REPO_NAME)) return githubRepoResponse(200);
        if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH, "main")) {
          return jsonResponse({ message: "Not Found" }, 404);
        }
        if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH)) {
          return jsonResponse({ content: { path: ROOT_NODE_PATH } }, 201);
        }
        if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH, "main")) {
          workflowReadCalls += 1;
          return workflowReadCalls === 1
            ? jsonResponse({ message: "Not Found" }, 404)
            : jsonResponse({ path: VALIDATE_TREE_WORKFLOW_PATH }, 200);
        }
        if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH)) {
          workflowCreateCalls += 1;
          return jsonResponse({ message: "File already exists" }, createConflictStatus);
        }
        return new Response(`unexpected fetch ${url}`, { status: 500 });
      });

      const res = await initialize(app, admin);

      expect(res.statusCode).toBe(201);
      expect(workflowReadCalls).toBe(2);
      expect(workflowCreateCalls).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(8);
      expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toEqual({
        provider: "github",
        repo: CLONE_URL,
        branch: "main",
      });
    });
  }

  it("can retry successfully when the root-node write failed after repo creation", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    await renameOrg(app, admin.organizationId, "Acme Labs");
    let repoCreateCalls = 0;
    let rootNodeWriteCalls = 0;
    let workflowWriteCalls = 0;
    mockFetch(async (url) => {
      if (url === installationTokenUrl(installationId)) return installationTokenResponse();
      if (url === orgReposUrl(ACCOUNT_LOGIN)) {
        repoCreateCalls += 1;
        return repoCreateCalls === 1
          ? githubRepoResponse(201)
          : jsonResponse({ message: "Repository creation failed." }, 422);
      }
      if (url === repoUrl(ACCOUNT_LOGIN, REPO_NAME)) return githubRepoResponse(200);
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH, "main")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH)) {
        rootNodeWriteCalls += 1;
        return rootNodeWriteCalls === 1
          ? jsonResponse({ message: "GitHub unavailable" }, 500)
          : jsonResponse({ content: { path: ROOT_NODE_PATH } }, 201);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH, "main")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH)) {
        workflowWriteCalls += 1;
        return jsonResponse({ content: { path: VALIDATE_TREE_WORKFLOW_PATH } }, 201);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const first = await initialize(app, admin);
    expect(first.statusCode).toBe(502);
    expect(first.json()).toMatchObject({ code: "upstream" });
    expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toBeNull();

    const second = await initialize(app, admin);
    expect(second.statusCode).toBe(201);
    expect(repoCreateCalls).toBe(2);
    expect(rootNodeWriteCalls).toBe(2);
    expect(workflowWriteCalls).toBe(1);
    expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toEqual({
      provider: "github",
      repo: CLONE_URL,
      branch: "main",
    });
  });

  it("can retry successfully when DB save failed after repo creation, root-node write, and workflow write", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    await renameOrg(app, admin.organizationId, "Acme Labs");
    let repoCreateCalls = 0;
    let rootNodeExists = false;
    let workflowExists = false;
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
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH, "main")) {
        return rootNodeExists
          ? jsonResponse({ path: ROOT_NODE_PATH }, 200)
          : jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, ROOT_NODE_PATH)) {
        rootNodeExists = true;
        return jsonResponse({ content: { path: ROOT_NODE_PATH } }, 201);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH, "main")) {
        return workflowExists
          ? jsonResponse({ path: VALIDATE_TREE_WORKFLOW_PATH }, 200)
          : jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === contentsUrl(ACCOUNT_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH)) {
        workflowExists = true;
        return jsonResponse({ content: { path: VALIDATE_TREE_WORKFLOW_PATH } }, 201);
      }
      return new Response(`unexpected fetch ${url}`, { status: 500 });
    });

    const first = await initialize(app, admin);
    expect(first.statusCode).toBe(500);
    expect(rootNodeExists).toBe(true);
    expect(workflowExists).toBe(true);
    expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toBeNull();

    const second = await initialize(app, admin);
    expect(second.statusCode).toBe(201);
    expect(repoCreateCalls).toBe(2);
    expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toEqual({
      provider: "github",
      repo: CLONE_URL,
      branch: "main",
    });
  });

  describe("personal GitHub account (User installation)", () => {
    it("adopts an existing personal repo the installation can access, without needing a GitHub user token", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const installationId = await seedUserInstallation(app, admin.organizationId);
      await renameOrg(app, admin.organizationId, "Acme Labs");
      // No GitHub identity seeded on purpose: adopting an already-accessible repo
      // uses only the installation token and must not require the user token.
      let userReposCalls = 0;
      const fetchSpy = mockFetch(async (url) => {
        if (url === installationTokenUrl(installationId)) return installationTokenResponse();
        if (url === repoUrl(USER_LOGIN, REPO_NAME)) return githubRepoResponse(200, { owner: USER_LOGIN });
        if (url === userReposUrl()) {
          userReposCalls += 1;
          return new Response("unexpected user repo create", { status: 500 });
        }
        if (url === contentsUrl(USER_LOGIN, REPO_NAME, ROOT_NODE_PATH, "main")) {
          return jsonResponse({ message: "Not Found" }, 404);
        }
        if (url === contentsUrl(USER_LOGIN, REPO_NAME, ROOT_NODE_PATH)) {
          return jsonResponse({ content: { path: ROOT_NODE_PATH } }, 201);
        }
        if (url === contentsUrl(USER_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH, "main")) {
          return jsonResponse({ message: "Not Found" }, 404);
        }
        if (url === contentsUrl(USER_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH)) {
          return jsonResponse({ content: { path: VALIDATE_TREE_WORKFLOW_PATH } }, 201);
        }
        return new Response(`unexpected fetch ${url}`, { status: 500 });
      });

      const res = await initialize(app, admin);

      expect(res.statusCode).toBe(201);
      expect(userReposCalls).toBe(0);
      expect(fetchSpy).toHaveBeenCalledTimes(6);
      expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toEqual({
        provider: "github",
        repo: USER_REPO_CLONE_URL,
        branch: "main",
      });
    });

    it("creates a personal repo with the GitHub user token when missing, verifies installation access, and persists", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const installationId = await seedUserInstallation(app, admin.organizationId);
      await renameOrg(app, admin.organizationId, "Acme Labs");
      await seedGithubIdentity(app, admin, {
        login: USER_LOGIN,
        accessToken: "ghu_user",
        githubId: String(USER_GITHUB_ID),
      });
      let createUserRepoPayload: unknown;
      let repoGetCalls = 0;
      const fetchSpy = mockFetch(async (url, init) => {
        if (url === installationTokenUrl(installationId)) return installationTokenResponse();
        if (url === repoUrl(USER_LOGIN, REPO_NAME)) {
          repoGetCalls += 1;
          // 1st GET: adopt probe → missing; 2nd GET: post-create access verify → found.
          return repoGetCalls === 1
            ? jsonResponse({ message: "Not Found" }, 404)
            : githubRepoResponse(200, { owner: USER_LOGIN });
        }
        if (url === userReposUrl()) {
          expectAuth(init, "Bearer ghu_user");
          createUserRepoPayload = parseJsonBody(init);
          return githubRepoResponse(201, { owner: USER_LOGIN });
        }
        if (url === contentsUrl(USER_LOGIN, REPO_NAME, ROOT_NODE_PATH, "main")) {
          return jsonResponse({ message: "Not Found" }, 404);
        }
        if (url === contentsUrl(USER_LOGIN, REPO_NAME, ROOT_NODE_PATH)) {
          return jsonResponse({ content: { path: ROOT_NODE_PATH } }, 201);
        }
        if (url === contentsUrl(USER_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH, "main")) {
          return jsonResponse({ message: "Not Found" }, 404);
        }
        if (url === contentsUrl(USER_LOGIN, REPO_NAME, VALIDATE_TREE_WORKFLOW_PATH)) {
          return jsonResponse({ content: { path: VALIDATE_TREE_WORKFLOW_PATH } }, 201);
        }
        return new Response(`unexpected fetch ${url}`, { status: 500 });
      });

      const res = await initialize(app, admin);

      expect(res.statusCode).toBe(201);
      expect(createUserRepoPayload).toMatchObject({
        name: REPO_NAME,
        private: true,
        auto_init: false,
        description: "Acme Labs Context Tree",
      });
      expect(repoGetCalls).toBe(2);
      expect(fetchSpy).toHaveBeenCalledTimes(8);
      expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toEqual({
        provider: "github",
        repo: USER_REPO_CLONE_URL,
        branch: "main",
      });
    });

    it("returns context_tree_repo_access_required when the created personal repo is still not visible to the installation", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const installationId = await seedUserInstallation(app, admin.organizationId);
      await renameOrg(app, admin.organizationId, "Acme Labs");
      await seedGithubIdentity(app, admin, {
        login: USER_LOGIN,
        accessToken: "ghu_user",
        githubId: String(USER_GITHUB_ID),
      });
      const fetchSpy = mockFetch(async (url) => {
        if (url === installationTokenUrl(installationId)) return installationTokenResponse();
        if (url === repoUrl(USER_LOGIN, REPO_NAME)) return jsonResponse({ message: "Not Found" }, 404);
        if (url === userReposUrl()) return githubRepoResponse(201, { owner: USER_LOGIN });
        return new Response(`unexpected fetch ${url}`, { status: 500 });
      });

      const res = await initialize(app, admin);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "context_tree_repo_access_required" });
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toBeNull();
    });

    it("returns context_tree_repo_access_required when the personal repo already exists but the installation cannot see it", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const installationId = await seedUserInstallation(app, admin.organizationId);
      await renameOrg(app, admin.organizationId, "Acme Labs");
      await seedGithubIdentity(app, admin, {
        login: USER_LOGIN,
        accessToken: "ghu_user",
        githubId: String(USER_GITHUB_ID),
      });
      const fetchSpy = mockFetch(async (url) => {
        if (url === installationTokenUrl(installationId)) return installationTokenResponse();
        if (url === repoUrl(USER_LOGIN, REPO_NAME)) return jsonResponse({ message: "Not Found" }, 404);
        if (url === userReposUrl()) return jsonResponse({ message: "name already exists on this account" }, 422);
        return new Response(`unexpected fetch ${url}`, { status: 500 });
      });

      const res = await initialize(app, admin);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "context_tree_repo_access_required" });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toBeNull();
    });

    it("returns 503 github_user_token_required without creating a repo when the admin has no GitHub token", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const installationId = await seedUserInstallation(app, admin.organizationId);
      await renameOrg(app, admin.organizationId, "Acme Labs");
      // No GitHub identity for this admin → no usable user token.
      let userReposCalls = 0;
      const fetchSpy = mockFetch(async (url) => {
        if (url === installationTokenUrl(installationId)) return installationTokenResponse();
        if (url === repoUrl(USER_LOGIN, REPO_NAME)) return jsonResponse({ message: "Not Found" }, 404);
        if (url === userReposUrl()) {
          userReposCalls += 1;
          return githubRepoResponse(201, { owner: USER_LOGIN });
        }
        return new Response(`unexpected fetch ${url}`, { status: 500 });
      });

      const res = await initialize(app, admin);

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "github_user_token_required" });
      expect(userReposCalls).toBe(0);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toBeNull();
    });

    it("returns context_tree_repo_account_mismatch when the admin's GitHub account differs from the installation account", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const installationId = await seedUserInstallation(app, admin.organizationId);
      await renameOrg(app, admin.organizationId, "Acme Labs");
      await seedGithubIdentity(app, admin, {
        login: "someone-else",
        accessToken: "ghu_other",
        githubId: "9999", // does not match USER_GITHUB_ID
      });
      let userReposCalls = 0;
      const fetchSpy = mockFetch(async (url) => {
        if (url === installationTokenUrl(installationId)) return installationTokenResponse();
        if (url === repoUrl(USER_LOGIN, REPO_NAME)) return jsonResponse({ message: "Not Found" }, 404);
        if (url === userReposUrl()) {
          userReposCalls += 1;
          return githubRepoResponse(201, { owner: USER_LOGIN });
        }
        return new Response(`unexpected fetch ${url}`, { status: 500 });
      });

      const res = await initialize(app, admin);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "context_tree_repo_account_mismatch" });
      expect(userReposCalls).toBe(0);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(await getOrgContextTreeBinding(app.db, admin.organizationId)).toBeNull();
    });
  });
});

describe("POST /orgs/:orgId/context-tree/seed-preflight", () => {
  const getApp = useTestApp({ githubAppPrivateKeyPem });

  it("uses only the authenticated explicit Team and returns stable Needs Admin after a live role change", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const outsideOrganizationId = await createOrganization(app, `outside-seed-${uuidv7().slice(0, 8)}`);
    const outsideBinding = {
      repo: "https://github.com/outside/private-context-tree.git",
      branch: "outside",
    };
    await putOrgSetting(app.db, outsideOrganizationId, "context_tree", outsideBinding, { updatedBy: admin.userId });

    const selected = await seedPreflight(app, admin.organizationId, admin.accessToken);
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toEqual({
      organizationId: admin.organizationId,
      state: { status: "unbound", branch: "main" },
    });

    const outside = await seedPreflight(app, outsideOrganizationId, admin.accessToken);
    expect(outside.statusCode).toBe(403);
    expect(outside.body).not.toContain(outsideBinding.repo);

    await app.db.update(members).set({ role: "member" }).where(eq(members.id, admin.memberId));
    const demoted = await seedPreflight(app, admin.organizationId, admin.accessToken);
    expect(demoted.statusCode).toBe(403);
    expect(demoted.json()).toEqual({
      error: "Context Tree Seed requires an active Team Admin.",
      code: "CONTEXT_TREE_SEED_NEEDS_ADMIN",
    });
  });
});

describe("GET /orgs/:orgId/context-tree/installation", () => {
  const getApp = useTestApp({ githubAppPrivateKeyPem });

  it("returns the bound installation's routing info without minting a token or calling GitHub", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const installationId = await seedInstallation(app, admin.organizationId);
    const fetchSpy = mockFetch(async () => new Response("unexpected", { status: 500 }));

    const res = await getInstallation(app, admin);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      installationId,
      accountLogin: ACCOUNT_LOGIN,
      accountType: "Organization",
      suspended: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows a non-admin member (the read is membership-gated, unlike /initialize)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedInstallation(app, admin.organizationId);
    const member = await createTestAdmin(app);
    await app.db
      .update(members)
      .set({ organizationId: admin.organizationId, role: "member" })
      .where(eq(members.id, member.memberId));

    const res = await getInstallation(app, { ...admin, accessToken: member.accessToken });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accountLogin: ACCOUNT_LOGIN });
  });

  it("returns 404 no_installation when no installation is bound", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const res = await getInstallation(app, admin);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "no_installation" });
  });

  it("reports a suspended installation so the CLI warns instead of silently failing coverage", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    await seedInstallation(app, admin.organizationId, { suspendedAt: "2026-05-11T10:00:00Z" });

    const res = await getInstallation(app, admin);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ suspended: true });
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

async function seedPreflight(app: FastifyInstance, organizationId: string, accessToken: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/orgs/${organizationId}/context-tree/seed-preflight`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {},
  });
}

async function getInstallation(app: FastifyInstance, admin: Pick<TestAdmin, "organizationId" | "accessToken">) {
  return app.inject({
    method: "GET",
    url: `/api/v1/orgs/${admin.organizationId}/context-tree/installation`,
    headers: { authorization: `Bearer ${admin.accessToken}` },
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
    accountGithubId?: number;
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
      accountGithubId: opts.accountGithubId ?? installationId + 1_000_000,
      permissions: opts.permissions ?? { administration: "write", contents: "write", workflows: "write" },
      events: opts.repositoryEvents ?? ["push"],
      suspendedAt: opts.suspendedAt ?? null,
    },
  });
  await bindInstallationToOrg(app.db, installationId, organizationId);
  return installationId;
}

async function seedUserInstallation(app: FastifyInstance, organizationId: string): Promise<number> {
  return seedInstallation(app, organizationId, {
    accountType: "User",
    accountLogin: USER_LOGIN,
    accountGithubId: USER_GITHUB_ID,
  });
}

async function seedGithubIdentity(
  app: FastifyInstance,
  admin: TestAdmin,
  opts: {
    login: string;
    accessToken: string;
    githubId?: string;
  },
): Promise<void> {
  await app.db.insert(authIdentities).values({
    id: uuidv7(),
    userId: admin.userId,
    provider: "github",
    identifier: opts.githubId ?? "123456",
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
      permissions: overrides.permissions ?? { administration: "write", contents: "write", workflows: "write" },
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

function userReposUrl(): string {
  return `${GITHUB_API_BASE}/user/repos`;
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
