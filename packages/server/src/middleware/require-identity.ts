import type { FastifyRequest } from "fastify";
import { UnauthorizedError } from "../errors.js";
import type { AdminIdentity, AgentIdentity } from "../types.js";

export function requireAgent(request: FastifyRequest): AgentIdentity {
  const agent = request.agent;
  if (!agent) {
    throw new UnauthorizedError("Agent authentication required");
  }
  return agent;
}

export function requireAdmin(request: FastifyRequest): AdminIdentity {
  const admin = request.admin;
  if (!admin) {
    throw new UnauthorizedError("Admin authentication required");
  }
  return admin;
}
