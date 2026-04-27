import type { FastifyRequest } from "fastify";
import { UnauthorizedError } from "../errors.js";
import type { AgentIdentity, AuthedUser, MemberIdentity } from "../types.js";

export function requireAgent(request: FastifyRequest): AgentIdentity {
  const agent = request.agent;
  if (!agent) {
    throw new UnauthorizedError("Agent authentication required");
  }
  return agent;
}

export function requireMember(request: FastifyRequest): MemberIdentity {
  const member = request.member;
  if (!member) {
    throw new UnauthorizedError("Member authentication required");
  }
  return member;
}

/**
 * Caller has a valid user-level JWT (`type: "user"` or `type: "access"`).
 * Used by routes like `/me/workspaces` that must work for both
 * brand-new users without memberships and existing users who want to
 * create / switch into another workspace.
 */
export function requireAuthedUser(request: FastifyRequest): AuthedUser {
  const user = request.authedUser;
  if (!user) {
    throw new UnauthorizedError("User authentication required");
  }
  return user;
}
