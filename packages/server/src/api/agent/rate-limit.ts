import type { FastifyRequest } from "fastify";
import { createLogger } from "../../observability/index.js";

const log = createLogger("AgentRateLimit");

/**
 * Per-agent rate limit on outbound message writes. Keyed by `agent.uuid`
 * (populated by `agentSelectorHook`, which runs as an onRequest hook before
 * the global limiter - registered with `hook: "preHandler"` - fires).
 *
 * Rationale: agent <-> agent reply loops are the documented failure mode
 * (`mention_only` is the semantic guard; this is the hard ceiling). Create-
 * and-send is also a message-write surface, so it uses the same bucket.
 */
export function agentMessageWriteRateLimit(max: number) {
  return {
    rateLimit: {
      max,
      timeWindow: "1 minute",
      keyGenerator: (req: FastifyRequest): string => {
        const agentId = req.agent?.uuid;
        if (agentId) return `agent:${agentId}`;
        log.warn(
          { ip: req.ip, route: req.routeOptions?.url ?? req.url },
          "rate-limit keyGenerator fell back to IP - req.agent missing on a route under /agent (hook order regression?)",
        );
        return `ip:${req.ip}`;
      },
    },
  };
}
