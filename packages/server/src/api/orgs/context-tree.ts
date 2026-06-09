import { initializeContextTreeRequestSchema, initializeContextTreeResponseSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { AppError, ConflictError, ForbiddenError } from "../../errors.js";
import { requireOrgAdmin } from "../../scope/require-org.js";
import { createRepoFile, createUserRepo, GithubApiError } from "../../services/github-oauth.js";
import { GithubUserTokenError, getFreshGithubUserToken } from "../../services/github-user-token.js";
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

    let github: { accessToken: string; login: string };
    try {
      github = await getFreshGithubUserToken(
        app.db,
        scope.userId,
        app.config.secrets.encryptionKey,
        app.config.oauth?.githubApp,
      );
    } catch (err) {
      if (err instanceof GithubUserTokenError) {
        if (err.cause) {
          app.log.warn({ err: err.cause, userId: scope.userId }, "context tree initialize: github token unavailable");
        }
        return reply.status(err.statusCode).send({
          error: err.message,
          ...(err.code ? { code: err.code } : {}),
        });
      }
      throw err;
    }

    const org = await getOrganization(app.db, scope.organizationId);
    const teamName = normalizeInlineText(org.displayName) || org.name;
    const repoName = contextTreeRepoName(teamName);
    app.log.info(
      {
        event: "context_tree.initialize.start",
        organizationId: scope.organizationId,
        userId: scope.userId,
        githubLogin: github.login,
        repoName,
      },
      "context tree initialize: creating github repo",
    );

    let repo: Awaited<ReturnType<typeof createUserRepo>>;
    try {
      repo = await createUserRepo(github.accessToken, {
        name: repoName,
        private: true,
        description: `${teamName} Context Tree`,
      });
    } catch (err) {
      app.log.warn(
        { err, organizationId: scope.organizationId, userId: scope.userId, githubLogin: github.login, repoName },
        "context tree initialize: create github repo failed",
      );
      throw mapCreateRepoError(err, github.login, repoName);
    }

    const nodeContent = initialRootNode(teamName, github.login);
    try {
      await createRepoFile(github.accessToken, {
        owner: repo.ownerLogin,
        repo: repo.name,
        path: ROOT_NODE_PATH,
        branch: BRANCH,
        message: "Initialize Context Tree root node",
        contentBase64: Buffer.from(nodeContent, "utf8").toString("base64"),
      });
    } catch (err) {
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
      throw mapCreateNodeError(err);
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

function mapCreateRepoError(err: unknown, login: string, repoName: string): AppError {
  if (err instanceof GithubApiError) {
    if (err.status === 422) {
      return new ConflictError(`GitHub repo ${login}/${repoName} already exists or the name is unavailable`);
    }
    if (err.status === 401 || err.status === 403) {
      return new ForbiddenError(
        "GitHub refused repo creation. Please reconnect your GitHub account and grant private repo access.",
      );
    }
  }
  return new AppError(502, "Couldn't create the GitHub repo. Try again in a moment.");
}

function mapCreateNodeError(err: unknown): AppError {
  if (err instanceof GithubApiError && (err.status === 401 || err.status === 403)) {
    return new ForbiddenError(
      "GitHub refused Context Tree root-node creation. Please reconnect your GitHub account and grant repo access.",
    );
  }
  return new AppError(502, "Couldn't initialize the Context Tree root node. Try again in a moment.");
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
