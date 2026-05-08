import type { FastifyRequest } from "fastify";
import { UnauthorizedError } from "../errors.js";
import type { AgentIdentity } from "../types.js";

/**
 * Pull the agent identity populated by `agentSelectorHook` off the
 * request. The hook runs before any handler and assigns `request.agent`,
 * but the optional shape is what fastify exposes to consumers — narrowing
 * it here keeps every Class D handler clean of `if (!request.agent)`.
 */
export function requireAgent(request: FastifyRequest): AgentIdentity {
  const agent = request.agent;
  if (!agent) {
    throw new UnauthorizedError("Agent authentication required");
  }
  return agent;
}
