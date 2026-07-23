import {
  AGENT_STATUSES,
  AGENT_TYPES,
  type ContextTreeActiveBinding,
  type ContextTreeProvider,
  type ContextTreeWritePreflightErrorCode,
  canonicalGitRepoUrl,
  contextTreeActiveBindingSchema,
} from "@first-tree/shared";
import { and, eq, sql } from "drizzle-orm";
import { ZodError } from "zod";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { members } from "../db/schema/members.js";
import { ForbiddenError } from "../errors.js";
import { getOrgContextReviewRuntime } from "./org-settings.js";

type RequesterIdentity = {
  userId: string;
  memberId: string;
  humanAgentUuid: string;
};

export type ContextTreeWritePreflightAuthority = {
  provider: ContextTreeProvider;
  binding: ContextTreeActiveBinding;
  gitlabInstanceOrigin: string | null;
  reviewerAgentUuid: string;
  requesterGithubLogin: string | null;
};

export class ContextTreeWritePreflightError extends Error {
  constructor(
    readonly code: ContextTreeWritePreflightErrorCode,
    readonly statusCode: 403 | 409,
    message: string,
  ) {
    super(message);
    this.name = "ContextTreeWritePreflightError";
  }
}

function canonicalBoundGithubRepository(value: string | null): string | null {
  const canonical = canonicalGitRepoUrl(value)?.toLowerCase() ?? null;
  return canonical?.startsWith("github.com/") ? canonical.slice("github.com/".length) : null;
}

async function readGithubIdentityLogin(db: Database, requester: RequesterIdentity): Promise<string | null> {
  const [identity] = await db
    .select({ login: sql<string | null>`${authIdentities.metadata}->>'login'` })
    .from(authIdentities)
    .where(and(eq(authIdentities.userId, requester.userId), eq(authIdentities.provider, "github")))
    .limit(1);
  return identity?.login?.trim() || null;
}

async function isActiveContextReviewer(
  db: Database,
  input: { organizationId: string; reviewerAgentUuid: string },
): Promise<boolean> {
  const [reviewer] = await db
    .select({
      uuid: agents.uuid,
      organizationId: agents.organizationId,
      type: agents.type,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.uuid, input.reviewerAgentUuid))
    .limit(1);
  return (
    reviewer !== undefined &&
    reviewer.organizationId === input.organizationId &&
    reviewer.type !== AGENT_TYPES.HUMAN &&
    reviewer.status === AGENT_STATUSES.ACTIVE
  );
}

async function requireActiveRequesterMembership(
  db: Database,
  input: { organizationId: string; requester: RequesterIdentity },
): Promise<void> {
  const [member] = await db
    .select({
      id: members.id,
      userId: members.userId,
      organizationId: members.organizationId,
      agentId: members.agentId,
      status: members.status,
    })
    .from(members)
    .where(eq(members.id, input.requester.memberId))
    .limit(1);
  if (
    !member ||
    member.userId !== input.requester.userId ||
    member.organizationId !== input.organizationId ||
    member.agentId !== input.requester.humanAgentUuid ||
    member.status !== "active"
  ) {
    throw new ForbiddenError("Context Tree Write requires the requester's active Team membership");
  }

  const [humanAgent] = await db
    .select({
      uuid: agents.uuid,
      organizationId: agents.organizationId,
      type: agents.type,
      status: agents.status,
      managerId: agents.managerId,
    })
    .from(agents)
    .where(eq(agents.uuid, input.requester.humanAgentUuid))
    .limit(1);
  if (
    !humanAgent ||
    humanAgent.organizationId !== input.organizationId ||
    humanAgent.type !== AGENT_TYPES.HUMAN ||
    humanAgent.status !== AGENT_STATUSES.ACTIVE ||
    humanAgent.managerId !== input.requester.memberId
  ) {
    throw new ForbiddenError("Context Tree Write requires the requester's active human identity");
  }
}

/**
 * Check whether a clean BYO writer may start or continue local authoring.
 * This is stateless: it creates no Chat, PR, review run, or merge authority.
 * The GitHub App webhook independently owns review dispatch after PR creation.
 */
export async function preflightContextTreeWriteAuthority(
  db: Database,
  input: {
    organizationId: string;
    requester: RequesterIdentity;
    requesterGithubLogin?: string;
  },
): Promise<ContextTreeWritePreflightAuthority> {
  try {
    await requireActiveRequesterMembership(db, input);
  } catch (error) {
    if (error instanceof ForbiddenError) {
      throw new ContextTreeWritePreflightError(
        "CONTEXT_TREE_WRITE_AUTHORITY_FAILED",
        403,
        "Context Tree Write requires the requester's current active Team membership and human identity.",
      );
    }
    throw error;
  }

  let runtime: Awaited<ReturnType<typeof getOrgContextReviewRuntime>>;
  try {
    runtime = await getOrgContextReviewRuntime(db, input.organizationId);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ContextTreeWritePreflightError(
        "CONTEXT_TREE_WRITE_CONFIGURATION_INVALID",
        409,
        "The selected Team's Context Tree Write configuration is invalid and must be repaired.",
      );
    }
    throw error;
  }

  const binding = contextTreeActiveBindingSchema.safeParse({ repo: runtime.repo, branch: runtime.branch });
  if (!binding.success) {
    throw new ContextTreeWritePreflightError(
      "CONTEXT_TREE_WRITE_BINDING_UNAVAILABLE",
      409,
      "The selected Team does not have a valid current Context Tree binding.",
    );
  }
  if (!runtime.provider || !runtime.providerMatchesRepository) {
    throw new ContextTreeWritePreflightError(
      "CONTEXT_TREE_WRITE_BINDING_UNSUPPORTED",
      409,
      "The selected Team's Context Tree provider cannot be resolved safely.",
    );
  }
  const resolvedBinding: ContextTreeActiveBinding = {
    ...binding.data,
    provider: runtime.provider,
  };
  if (runtime.provider === "gitlab" && !runtime.gitlabConnection) {
    throw new ContextTreeWritePreflightError(
      "CONTEXT_TREE_WRITE_GITLAB_CONNECTION_MISMATCH",
      409,
      "The current GitLab connection origin does not match the Context Tree repository.",
    );
  }
  if (!runtime.contextReviewer.enabled || !runtime.contextReviewer.agentUuid) {
    throw new ContextTreeWritePreflightError(
      "CONTEXT_TREE_WRITE_REVIEW_UNAVAILABLE",
      409,
      "The selected Team does not currently have Context Reviewer enabled with an assigned Reviewer.",
    );
  }

  const reviewerAgentUuid = runtime.contextReviewer.agentUuid;
  if (!(await isActiveContextReviewer(db, { organizationId: input.organizationId, reviewerAgentUuid }))) {
    throw new ContextTreeWritePreflightError(
      "CONTEXT_TREE_WRITE_REVIEWER_UNAVAILABLE",
      409,
      "The selected Team's current Reviewer is not an active non-human Agent in that Team.",
    );
  }

  if (runtime.provider === "gitlab") {
    return {
      provider: "gitlab",
      binding: resolvedBinding,
      gitlabInstanceOrigin: runtime.gitlabConnection?.instanceOrigin ?? null,
      reviewerAgentUuid,
      requesterGithubLogin: null,
    };
  }

  if (canonicalBoundGithubRepository(binding.data.repo) === null) {
    throw new ContextTreeWritePreflightError(
      "CONTEXT_TREE_WRITE_BINDING_UNSUPPORTED",
      409,
      "GitHub Context Review requires the selected Team's Context Tree binding to be on GitHub.",
    );
  }
  const linkedGithubLogin = await readGithubIdentityLogin(db, input.requester);
  if (!linkedGithubLogin || !input.requesterGithubLogin) {
    throw new ContextTreeWritePreflightError(
      "CONTEXT_TREE_WRITE_GITHUB_IDENTITY_REQUIRED",
      403,
      "Connect your GitHub identity to First Tree before starting Context Tree Write.",
    );
  }
  if (linkedGithubLogin.toLowerCase() !== input.requesterGithubLogin.toLowerCase()) {
    throw new ContextTreeWritePreflightError(
      "CONTEXT_TREE_WRITE_GITHUB_IDENTITY_MISMATCH",
      403,
      "The local GitHub login does not match the signed-in First Tree member.",
    );
  }

  return {
    provider: "github",
    binding: resolvedBinding,
    gitlabInstanceOrigin: null,
    reviewerAgentUuid,
    requesterGithubLogin: linkedGithubLogin,
  };
}
