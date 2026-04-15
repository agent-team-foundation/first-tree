import type { FastifyRequest } from "fastify";
import { UnauthorizedError } from "../errors.js";
import type { AgentIdentity, MemberIdentity } from "../types.js";

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
