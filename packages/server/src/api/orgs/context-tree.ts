import { initializeContextTreeRequestSchema, initializeContextTreeResponseSchema } from "@first-tree/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ConflictError } from "../../errors.js";
import { requireOrgAdmin } from "../../scope/require-org.js";
import {
  createOrganizationRepo,
  createRepoFileWithToken,
  GithubAppApiError,
  getRepoFileWithToken,
  getRepository,
} from "../../services/github-app.js";
import { findInstallationByOrg, type InstallationRow } from "../../services/github-app-installations.js";
import { mintContextTreeInstallationToken } from "../../services/github-app-token.js";
import type { GithubCreatedRepo } from "../../services/github-oauth.js";
import { getOrgContextTree, putOrgSetting } from "../../services/org-settings.js";
import { getOrganization } from "../../services/organization.js";

const BRANCH = "main";
const ROOT_NODE_PATH = "NODE.md";
const REPO_SUFFIX = "-context-tree";
const GITHUB_REPO_NAME_MAX_LENGTH = 100;

export async function orgContextTreeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { orgId: string }; Body: unknown }>("/initialize", async (request, reply) => {
    initializeContextTreeRequestSchema.parse(request.body ?? {});
    const scope = await requireOrgAdmin(request, app.db);

    const existing = await getOrgContextTree(app.db, scope.organizationId);
    if (existing.repo) {
      throw new ConflictError("Context Tree repo is already configured for this team");
    }

    const installation = await findInstallationByOrg(app.db, scope.organizationId);
    const mint = await mintContextTreeInstallationToken(installation, app.config.oauth?.githubApp);
    if (!mint.ok) {
      return sendMintFailure(reply, mint, scope.organizationId, app);
    }
    if (!installation) {
      return reply.status(503).send({
        error: "No GitHub App installation is connected for this team yet.",
        code: "no_installation",
      });
    }
    if (installation.accountType !== "Organization") {
      return reply.status(409).send({
        error: "One-click Context Tree initialization requires a GitHub organization installation.",
        code: "organization_installation_required",
      });
    }
    if (mint.repositorySelection !== "all") {
      return reply.status(409).send({
        error:
          "One-click Context Tree initialization requires the GitHub App installation to have access to all repositories.",
        code: "selected_repositories_unsupported",
      });
    }
    if (!hasInitializationPermissions(mint.permissions)) {
      return reply.status(403).send({
        error:
          "The GitHub App installation needs administration: write and contents: write permissions to initialize a Context Tree repo.",
        code: "installation_permissions_insufficient",
      });
    }

    const org = await getOrganization(app.db, scope.organizationId);
    const teamName = normalizeInlineText(org.displayName) || org.name;
    const repoName = contextTreeRepoName(teamName);
    app.log.info(
      {
        event: "context_tree.initialize.start",
        organizationId: scope.organizationId,
        userId: scope.userId,
        installationId: installation.installationId,
        githubAccount: installation.accountLogin,
        repoName,
      },
      "context tree initialize: creating or adopting github repo",
    );

    let repo: GithubCreatedRepo;
    try {
      repo = await createOrAdoptContextTreeRepo({
        installationToken: mint.token,
        installation,
        repoName,
        teamName,
      });
    } catch (err) {
      if (err instanceof ContextTreeInitializeError) {
        app.log.warn(
          {
            err,
            organizationId: scope.organizationId,
            installationId: installation.installationId,
            githubAccount: installation.accountLogin,
            repoName,
            code: err.code,
          },
          "context tree initialize: create or adopt github repo failed",
        );
        return reply.status(err.statusCode).send({ error: err.message, code: err.code });
      }
      app.log.warn(
        {
          err,
          organizationId: scope.organizationId,
          installationId: installation.installationId,
          githubAccount: installation.accountLogin,
          repoName,
        },
        "context tree initialize: create or adopt github repo failed",
      );
      throw err;
    }

    const nodeContent = initialRootNode(teamName, installation.accountLogin);
    try {
      await ensureRootNode(mint.token, repo, nodeContent);
    } catch (err) {
      if (err instanceof ContextTreeInitializeError) {
        app.log.warn(
          {
            err,
            organizationId: scope.organizationId,
            userId: scope.userId,
            repo: repo.fullName,
            nodePath: ROOT_NODE_PATH,
            code: err.code,
          },
          "context tree initialize: create root node failed",
        );
        return reply.status(err.statusCode).send({ error: err.message, code: err.code });
      }
      app.log.warn(
        {
          err,
          organizationId: scope.organizationId,
          userId: scope.userId,
          repo: repo.fullName,
          nodePath: ROOT_NODE_PATH,
        },
        "context tree initialize: create root node failed",
      );
      throw err;
    }

    const setting = await putOrgSetting(
      app.db,
      scope.organizationId,
      "context_tree",
      { repo: repo.cloneUrl, branch: BRANCH },
      { updatedBy: scope.userId },
    );

    app.log.info(
      {
        event: "context_tree.initialize.complete",
        organizationId: scope.organizationId,
        userId: scope.userId,
        repo: repo.fullName,
        nodePath: ROOT_NODE_PATH,
      },
      "context tree initialize: saved organization setting",
    );

    return reply.status(201).send(
      initializeContextTreeResponseSchema.parse({
        repo: setting.repo ?? repo.cloneUrl,
        htmlUrl: repo.htmlUrl,
        branch: BRANCH,
        nodePath: ROOT_NODE_PATH,
      }),
    );
  });
}

class ContextTreeInitializeError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ContextTreeInitializeError";
  }
}

function sendMintFailure(
  reply: FastifyReply,
  mint: Exclude<Awaited<ReturnType<typeof mintContextTreeInstallationToken>>, { ok: true }>,
  organizationId: string,
  app: FastifyInstance,
) {
  if (mint.reason === "no-installation") {
    return reply
      .status(503)
      .send({ error: "No GitHub App installation is connected for this team yet.", code: "no_installation" });
  }
  if (mint.reason === "suspended") {
    return reply.status(503).send({ error: "This team's GitHub App installation is suspended.", code: "suspended" });
  }
  if (mint.reason === "no-app-config") {
    return reply.status(503).send({ error: "GitHub App is not configured on this server.", code: "not_configured" });
  }
  app.log.warn({ organizationId, detail: mint.detail }, "context tree initialize: installation token mint failed");
  return reply.status(502).send({ error: "Couldn't reach GitHub. Try again in a moment.", code: "upstream" });
}

function hasInitializationPermissions(permissions: Record<string, "read" | "write" | "admin">): boolean {
  return permissions.administration === "write" && permissions.contents === "write";
}

async function createOrAdoptContextTreeRepo(input: {
  installationToken: string;
  installation: InstallationRow;
  repoName: string;
  teamName: string;
}): Promise<GithubCreatedRepo> {
  try {
    const created = await createOrganizationRepo(input.installationToken, {
      org: input.installation.accountLogin,
      name: input.repoName,
      private: true,
      description: `${input.teamName} Context Tree`,
    });
    return await verifyCreatedRepository(input.installationToken, created.ownerLogin, created.name);
  } catch (err) {
    if (err instanceof GithubAppApiError && err.status === 422) {
      return await adoptExistingRepository(input.installationToken, input.installation.accountLogin, input.repoName);
    }
    throw mapUpstreamError(err, "Couldn't create the GitHub repo. Try again in a moment.");
  }
}

async function verifyCreatedRepository(
  installationToken: string,
  owner: string,
  repoName: string,
): Promise<GithubCreatedRepo> {
  try {
    return await getRepository(installationToken, owner, repoName);
  } catch (err) {
    throw mapUpstreamError(err, "Couldn't verify the created GitHub repo. Try again in a moment.");
  }
}

async function adoptExistingRepository(
  installationToken: string,
  owner: string,
  repoName: string,
): Promise<GithubCreatedRepo> {
  try {
    return await getRepository(installationToken, owner, repoName);
  } catch (err) {
    if (err instanceof GithubAppApiError && (err.status === 403 || err.status === 404)) {
      throw new ContextTreeInitializeError(
        409,
        "repo_unavailable",
        `GitHub repo ${owner}/${repoName} already exists but is not accessible to this team's GitHub App installation.`,
      );
    }
    throw mapUpstreamError(err, "Couldn't verify the existing GitHub repo. Try again in a moment.");
  }
}

async function ensureRootNode(installationToken: string, repo: GithubCreatedRepo, nodeContent: string): Promise<void> {
  try {
    await getRepoFileWithToken(installationToken, {
      owner: repo.ownerLogin,
      repo: repo.name,
      path: ROOT_NODE_PATH,
      branch: BRANCH,
    });
    return;
  } catch (err) {
    if (!(err instanceof GithubAppApiError) || err.status !== 404) {
      throw mapUpstreamError(err, "Couldn't verify the Context Tree root node. Try again in a moment.");
    }
  }

  try {
    await createRepoFileWithToken(installationToken, {
      owner: repo.ownerLogin,
      repo: repo.name,
      path: ROOT_NODE_PATH,
      branch: BRANCH,
      message: "Initialize Context Tree root node",
      contentBase64: Buffer.from(nodeContent, "utf8").toString("base64"),
    });
  } catch (err) {
    if (err instanceof GithubAppApiError && (err.status === 409 || err.status === 422)) {
      await verifyExistingRootNode(installationToken, repo);
      return;
    }
    throw mapUpstreamError(err, "Couldn't initialize the Context Tree root node. Try again in a moment.");
  }
}

async function verifyExistingRootNode(installationToken: string, repo: GithubCreatedRepo): Promise<void> {
  try {
    await getRepoFileWithToken(installationToken, {
      owner: repo.ownerLogin,
      repo: repo.name,
      path: ROOT_NODE_PATH,
      branch: BRANCH,
    });
  } catch (err) {
    throw mapUpstreamError(err, "Couldn't verify the existing Context Tree root node. Try again in a moment.");
  }
}

function mapUpstreamError(err: unknown, message: string): ContextTreeInitializeError {
  if (err instanceof ContextTreeInitializeError) {
    return err;
  }
  return new ContextTreeInitializeError(502, "upstream", message);
}

function contextTreeRepoName(teamName: string): string {
  const maxBaseLength = GITHUB_REPO_NAME_MAX_LENGTH - REPO_SUFFIX.length;
  const base = slugifyRepoBase(teamName).slice(0, maxBaseLength).replace(/-+$/g, "") || "team";
  return `${base}${REPO_SUFFIX}`;
}

function slugifyRepoBase(value: string): string {
  const ascii = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug || "team";
}

function initialRootNode(teamName: string, githubLogin: string): string {
  const title = `${teamName} Context Tree`;
  const description = `Shared context, decisions, ownership, and operating knowledge for ${teamName}.`;
  return `---
title: ${yamlDoubleQuote(title)}
description: ${yamlDoubleQuote(description)}
owners: [${githubLogin}]
---

# ${teamName}'s Context Tree
`;
}

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(normalizeInlineText(value));
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
