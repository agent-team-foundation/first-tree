import { createHash } from "node:crypto";
import {
  type ContextTreeRecoveryAction,
  contextTreeInstallationInfoResponseSchema,
  initializeContextTreeRequestSchema,
  initializeContextTreeResponseSchema,
  treeSetupKickoffSchema,
} from "@first-tree/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ConflictError } from "../../errors.js";
import { requireOrgAdmin, requireOrgMembership } from "../../scope/require-org.js";
import {
  ContextTreeRepoProvisionError,
  ensureInstallationOwnedContextTreeRepo,
} from "../../services/context-tree-repo-provisioner.js";
import {
  type ContextTreeBinding,
  getContextTreeSnapshot,
  isGithubRemoteBinding,
} from "../../services/context-tree-snapshot.js";
import { createRepoFileWithToken, GithubAppApiError, getRepoFileWithToken } from "../../services/github-app.js";
import { findInstallationByOrg } from "../../services/github-app-installations.js";
import {
  type ContextTreeInstallationTokenResult,
  mintContextTreeInstallationToken,
  resolveContextTreeRecoveryAction,
} from "../../services/github-app-token.js";
import type { GithubCreatedRepo } from "../../services/github-oauth.js";
import { GithubUserTokenError, getFreshGithubUserToken } from "../../services/github-user-token.js";
import { notifyRecipients } from "../../services/notifier.js";
import {
  adoptSafeLegacyTreeSetupChat,
  appendTreeSetupRecoveryMessage,
  kickoffOnboarding,
  type TreeSetupRecoveryMessage,
} from "../../services/onboarding-kickoff.js";
import {
  getOrgContextTreeBinding,
  getOrgSetting,
  putInitializedOrgContextTreeBinding,
} from "../../services/org-settings.js";
import { getOrganization } from "../../services/organization.js";

const BRANCH = "main";
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
const REPO_SUFFIX = "-context-tree";
const GITHUB_REPO_NAME_MAX_LENGTH = 100;
const TREE_SETUP_TOPIC = "Set up shared context";
const TREE_SETUP_BOOTSTRAP = [
  "Let's build or finish our team's Context Tree.",
  "",
  "Please inspect the actual tree state, then read .first-tree/workspace.json before choosing sources. A non-empty source manifest is authoritative: every declared clone must exist and be readable; report a missing declared clone as a blocking half-provisioned workspace instead of bypassing it with another source. Only when the manifest is empty or absent may you ask me for one local project folder path or GitHub repository URL. Once you have readable code, propose the initial top- and second-level domain structure for my review before writing it. Use this same chat to continue after approval; never restart a populated tree.",
].join("\n");

export async function orgContextTreeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { orgId: string }; Body: unknown }>("/setup-chat", async (request, reply) => {
    const scope = await requireOrgAdmin(request, app.db);
    const body = treeSetupKickoffSchema.parse(request.body);
    const binding: ContextTreeBinding = (await getOrgContextTreeBinding(app.db, scope.organizationId)) ?? {};
    const recovery = await resolveTreeSetupRecoveryMessage(app, scope.organizationId, binding);
    await adoptSafeLegacyTreeSetupChat(app.db, {
      humanAgentId: scope.humanAgentId,
      organizationId: scope.organizationId,
      targetAgentId: body.agentUuid,
    });
    const result = await kickoffOnboarding(app.db, {
      memberId: scope.memberId,
      humanAgentId: scope.humanAgentId,
      organizationId: scope.organizationId,
      targetAgentId: body.agentUuid,
      bootstrap: recovery?.content ?? TREE_SETUP_BOOTSTRAP,
      ...(recovery ? { bootstrapMetadata: { contextTreeRecoveryFingerprint: recovery.fingerprint } } : {}),
      topic: TREE_SETUP_TOPIC,
      // A setup chat is an ordinary private task chat, so its stable identity
      // must stay inside the initiating human + selected private-agent ACL.
      // Org-level status still recognizes any completed setup bootstrap below.
      kickoffKey: `${scope.humanAgentId}:${body.agentUuid}:tree-setup`,
      complete: false,
    });
    if (result.sent) {
      notifyRecipients(app.notifier, result.sent.recipients, result.sent.messageId);
      app.log.info(
        { event: "context_tree.setup_chat", userId: scope.userId, chatId: result.chatId },
        "context tree: setup chat kickoff",
      );
    }
    if (recovery && !result.sent) {
      const sent = await appendTreeSetupRecoveryMessage(app.db, {
        chatId: result.chatId,
        humanAgentId: scope.humanAgentId,
        targetAgentId: body.agentUuid,
        recovery,
      });
      if (sent) {
        notifyRecipients(app.notifier, sent.recipients, sent.messageId);
        app.log.info(
          {
            event: "context_tree.setup_chat_recovery",
            userId: scope.userId,
            chatId: result.chatId,
            repo: binding.repo ?? null,
            branch: binding.branch ?? null,
          },
          "context tree: setup chat recovery turn",
        );
      }
    }
    return reply.status(200).send({ chatId: result.chatId });
  });

  // Read-only routing view of the team's bound GitHub App installation. The
  // agent-driven `first-tree tree init` flow calls this after creating the tree
  // repo with local `gh` to build the "add this repo to your installation"
  // guidance URL. Context: GitHub auto-attaches a repo to an installation only
  // when the *App* creates it (via its installation token); a repo created by
  // the *user* (local `gh`) is not auto-covered by a selected-repositories
  // installation, and the local `gh` token cannot add it (it is not authorized
  // for this App — `/user/installations/*` returns 403). So the reliable path is
  // to point the admin at the installation settings page. No token is minted
  // here — only the non-secret installation id + account are returned.
  app.get<{ Params: { orgId: string } }>("/installation", async (request, reply) => {
    const scope = await requireOrgMembership(request, app.db);
    const installation = await findInstallationByOrg(app.db, scope.organizationId);
    if (!installation) {
      return reply.status(404).send({
        error: "No GitHub App installation is connected for this team yet.",
        code: "no_installation",
      });
    }
    // Build untyped and validate through the schema: Drizzle widens
    // `accountType` to `string`, so `.parse()` is what narrows it to the
    // `User | Organization` union (and rejects a corrupt row at runtime).
    return reply.status(200).send(
      contextTreeInstallationInfoResponseSchema.parse({
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        suspended: installation.suspendedAt !== null,
      }),
    );
  });

  app.post<{ Params: { orgId: string }; Body: unknown }>("/initialize", async (request, reply) => {
    initializeContextTreeRequestSchema.parse(request.body ?? {});
    const scope = await requireOrgAdmin(request, app.db);

    const existing = await getOrgSetting(app.db, scope.organizationId, "context_tree");
    if (existing.repo !== undefined) {
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
    if (!hasInitializationPermissions(mint.permissions)) {
      return reply.status(403).send({
        error:
          "The GitHub App installation needs administration: write, contents: write, and workflows: write permissions to initialize a Context Tree repo.",
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

    const refreshConfig = app.config.oauth?.githubApp;
    let repo: GithubCreatedRepo;
    try {
      repo = await ensureInstallationOwnedContextTreeRepo({
        installation,
        installationToken: mint.token,
        repoName,
        teamName,
        getUserToken: () =>
          getFreshGithubUserToken(app.db, scope.userId, app.config.secrets.encryptionKey, refreshConfig),
      });
    } catch (err) {
      if (err instanceof ContextTreeRepoProvisionError) {
        app.log.warn(
          {
            err,
            organizationId: scope.organizationId,
            installationId: installation.installationId,
            githubAccount: installation.accountLogin,
            accountType: installation.accountType,
            repoName,
            code: err.code,
          },
          "context tree initialize: provision repo failed",
        );
        return reply.status(err.statusCode).send({ error: err.message, code: err.code });
      }
      if (err instanceof GithubUserTokenError) {
        app.log.warn(
          {
            err: err.cause ?? err,
            organizationId: scope.organizationId,
            userId: scope.userId,
            installationId: installation.installationId,
            githubAccount: installation.accountLogin,
          },
          "context tree initialize: github user token unavailable",
        );
        return reply.status(err.statusCode).send({ error: err.message, code: "github_user_token_required" });
      }
      app.log.warn(
        {
          err,
          organizationId: scope.organizationId,
          installationId: installation.installationId,
          githubAccount: installation.accountLogin,
          repoName,
        },
        "context tree initialize: provision repo failed",
      );
      throw err;
    }

    const nodeContent = initialRootNode(teamName, installation.accountLogin);
    try {
      await ensureRepoFile(mint.token, repo, {
        path: ROOT_NODE_PATH,
        content: nodeContent,
        commitMessage: "Initialize Context Tree root node",
        verifyErrorMessage: "Couldn't verify the Context Tree root node. Try again in a moment.",
        createErrorMessage: "Couldn't initialize the Context Tree root node. Try again in a moment.",
        verifyExistingErrorMessage: "Couldn't verify the existing Context Tree root node. Try again in a moment.",
      });
    } catch (err) {
      if (err instanceof ContextTreeInitializeError) {
        app.log.warn(
          {
            err,
            organizationId: scope.organizationId,
            userId: scope.userId,
            repo: repo.fullName,
            nodePath: ROOT_NODE_PATH,
            filePath: ROOT_NODE_PATH,
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
          filePath: ROOT_NODE_PATH,
        },
        "context tree initialize: create root node failed",
      );
      throw err;
    }

    try {
      await ensureRepoFile(mint.token, repo, {
        path: VALIDATE_TREE_WORKFLOW_PATH,
        content: VALIDATE_TREE_WORKFLOW_CONTENT,
        commitMessage: "Initialize Context Tree validation workflow",
        verifyErrorMessage: "Couldn't verify the Context Tree validation workflow. Try again in a moment.",
        createErrorMessage: "Couldn't initialize the Context Tree validation workflow. Try again in a moment.",
        verifyExistingErrorMessage:
          "Couldn't verify the existing Context Tree validation workflow. Try again in a moment.",
      });
    } catch (err) {
      if (err instanceof ContextTreeInitializeError) {
        app.log.warn(
          {
            err,
            organizationId: scope.organizationId,
            userId: scope.userId,
            repo: repo.fullName,
            workflowPath: VALIDATE_TREE_WORKFLOW_PATH,
            filePath: VALIDATE_TREE_WORKFLOW_PATH,
            code: err.code,
          },
          "context tree initialize: create validation workflow failed",
        );
        return reply.status(err.statusCode).send({ error: err.message, code: err.code });
      }
      app.log.warn(
        {
          err,
          organizationId: scope.organizationId,
          userId: scope.userId,
          repo: repo.fullName,
          workflowPath: VALIDATE_TREE_WORKFLOW_PATH,
          filePath: VALIDATE_TREE_WORKFLOW_PATH,
        },
        "context tree initialize: create validation workflow failed",
      );
      throw err;
    }

    const setting = await putInitializedOrgContextTreeBinding(
      app.db,
      scope.organizationId,
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
        workflowPath: VALIDATE_TREE_WORKFLOW_PATH,
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

async function resolveTreeSetupRecoveryMessage(
  app: FastifyInstance,
  organizationId: string,
  binding: ContextTreeBinding,
): Promise<TreeSetupRecoveryMessage | null> {
  if (!binding.repo && !binding.localPath) return null;

  let mintResult: ContextTreeInstallationTokenResult | null = null;
  if (isGithubRemoteBinding(binding)) {
    const installation = await findInstallationByOrg(app.db, organizationId);
    mintResult = await mintContextTreeInstallationToken(installation, app.config.oauth?.githubApp);
  }
  const snapshot = await getContextTreeSnapshot({
    ...binding,
    ...(mintResult?.ok ? { githubToken: mintResult.token } : {}),
  });
  if (snapshot.snapshotStatus !== "unavailable") return null;
  const recoveryAction = mintResult ? await resolveContextTreeRecoveryAction(snapshot, binding, mintResult) : null;
  return treeSetupRecoveryMessage(
    binding,
    snapshot.contextStatus.detail ?? "First Tree could not read the configured Context Tree snapshot.",
    recoveryAction,
  );
}

function treeSetupRecoveryMessage(
  binding: ContextTreeBinding,
  detail: string,
  recoveryAction: ContextTreeRecoveryAction | null,
): TreeSetupRecoveryMessage {
  const diagnostic = {
    repo: binding.repo ?? null,
    branch: binding.branch ?? null,
    snapshotStatus: "unavailable",
    detail,
    recoveryAction,
  } as const;
  const fingerprintDiagnostic = {
    ...diagnostic,
    // A failed remote clone is cached briefly and the second read prefixes the
    // same cause with this sentence. Strip only that transport-cache wrapper so
    // an immediate retry deduplicates while a genuinely different diagnosis
    // still produces a fresh turn.
    detail: detail.replace(/Previous Context Tree sync failed recently\.\s*/gu, ""),
  };
  const fingerprint = createHash("sha256").update(JSON.stringify(fingerprintDiagnostic)).digest("hex");
  const content = [
    TREE_SETUP_BOOTSTRAP,
    "",
    "Current server-resolved recovery diagnostic:",
    `- Configured repository: ${diagnostic.repo ?? "(local workspace binding)"}`,
    `- Configured branch: ${diagnostic.branch ?? "(repository default)"}`,
    `- Snapshot status: ${diagnostic.snapshotStatus}`,
    `- Detail: ${diagnostic.detail}`,
    `- Structured recovery hint: ${diagnostic.recoveryAction ?? "none"}`,
    "",
    "Re-check the current binding, repository, branch, and readable workspace state in this chat before changing anything.",
  ].join("\n");
  return { content, fingerprint };
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
  return (
    permissions.administration === "write" && permissions.contents === "write" && permissions.workflows === "write"
  );
}

async function ensureRepoFile(
  installationToken: string,
  repo: GithubCreatedRepo,
  input: {
    path: string;
    content: string;
    commitMessage: string;
    verifyErrorMessage: string;
    createErrorMessage: string;
    verifyExistingErrorMessage: string;
  },
): Promise<void> {
  try {
    await getRepoFileWithToken(installationToken, {
      owner: repo.ownerLogin,
      repo: repo.name,
      path: input.path,
      branch: BRANCH,
    });
    return;
  } catch (err) {
    if (err instanceof GithubAppApiError && err.status === 404) {
      // The file does not exist yet; create it below.
    } else if (err instanceof GithubAppApiError && isRepoAccessError(err)) {
      throw repoUnavailableError(repo.ownerLogin, repo.name);
    } else {
      throw mapUpstreamError(err, input.verifyErrorMessage);
    }
  }

  try {
    await createRepoFileWithToken(installationToken, {
      owner: repo.ownerLogin,
      repo: repo.name,
      path: input.path,
      branch: BRANCH,
      message: input.commitMessage,
      contentBase64: Buffer.from(input.content, "utf8").toString("base64"),
    });
  } catch (err) {
    if (err instanceof GithubAppApiError && (err.status === 409 || err.status === 422)) {
      await verifyExistingRepoFile(installationToken, repo, input.path, input.verifyExistingErrorMessage);
      return;
    }
    if (err instanceof GithubAppApiError && isRepoAccessError(err)) {
      throw repoUnavailableError(repo.ownerLogin, repo.name);
    }
    throw mapUpstreamError(err, input.createErrorMessage);
  }
}

async function verifyExistingRepoFile(
  installationToken: string,
  repo: GithubCreatedRepo,
  path: string,
  errorMessage: string,
): Promise<void> {
  try {
    await getRepoFileWithToken(installationToken, {
      owner: repo.ownerLogin,
      repo: repo.name,
      path,
      branch: BRANCH,
    });
  } catch (err) {
    if (err instanceof GithubAppApiError && isRepoAccessError(err)) {
      throw repoUnavailableError(repo.ownerLogin, repo.name);
    }
    throw mapUpstreamError(err, errorMessage);
  }
}

function isRepoAccessError(err: GithubAppApiError): boolean {
  return err.status === 403 || err.status === 404;
}

function repoUnavailableError(owner: string, repoName: string): ContextTreeInitializeError {
  return new ContextTreeInitializeError(
    409,
    "repo_unavailable",
    `GitHub repo ${owner}/${repoName} is not accessible to this team's GitHub App installation.`,
  );
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
