import {
  AGENT_STATUSES,
  AGENT_TYPES,
  type ContextTreeActiveBinding,
  type ContextTreeWritePreflightErrorCode,
  canonicalGitRepoUrl,
} from "@first-tree/shared";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { members } from "../db/schema/members.js";
import { ForbiddenError } from "../errors.js";
import { getOrgContextTreeSettingState } from "./org-settings.js";

type RequesterIdentity = {
  userId: string;
  memberId: string;
  humanAgentUuid: string;
};

export type ContextTreeWritePreflightAuthority = {
  binding: ContextTreeActiveBinding;
  requesterGithubLogin: string;
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
    requesterGithubLogin: string;
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

  const bindingState = await getOrgContextTreeSettingState(db, input.organizationId);
  if (bindingState.kind === "invalid") {
    throw new ContextTreeWritePreflightError(
      "CONTEXT_TREE_WRITE_CONFIGURATION_INVALID",
      409,
      "The selected Team's Context Tree Write configuration is invalid and must be repaired.",
    );
  }
  if (bindingState.kind !== "bound") {
    throw new ContextTreeWritePreflightError(
      "CONTEXT_TREE_WRITE_BINDING_UNAVAILABLE",
      409,
      "The selected Team does not have a valid current Context Tree binding.",
    );
  }
  if (canonicalBoundGithubRepository(bindingState.binding.repo) === null) {
    throw new ContextTreeWritePreflightError(
      "CONTEXT_TREE_WRITE_BINDING_UNSUPPORTED",
      409,
      "GitHub App Context Review requires the selected Team's Context Tree binding to be on GitHub.",
    );
  }

  const linkedGithubLogin = await readGithubIdentityLogin(db, input.requester);
  if (!linkedGithubLogin) {
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

  return { binding: bindingState.binding, requesterGithubLogin: linkedGithubLogin };
}
