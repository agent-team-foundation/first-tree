import { AGENT_CAPABILITIES, AGENT_SOURCES, AGENT_TYPES, createManagedAgentSchema } from "@first-tree/shared";
import { getServerCliBinding } from "@first-tree/shared/channel";
import type { FastifyInstance } from "fastify";
import { ForbiddenError } from "../../errors.js";
import { requireAgent } from "../../middleware/require-identity.js";
import * as agentService from "../../services/agent.js";

/**
 * Gated agent self-provisioning — agent self surface (Class D, `/api/v1/agent`).
 *
 *   POST /agent/managed-agents — the acting agent creates a *teammate* agent.
 *
 * This is the ONE server-enforced, agent-attributable path for provisioning
 * (issue #1885). Because it lives in the agent namespace, `agentSelectorHook`
 * has already proven a live agent runtime is calling (user JWT + `X-Agent-Id`,
 * R-RUN: the pinned client is owned by the caller's user). On top of that:
 *
 *   - **Capability gate** — the acting agent must hold the `provision-agents`
 *     capability, granted only by an org admin (default-deny).
 *   - **Scope is forced from the actor, never the body** — the new agent's
 *     `organizationId` is the acting agent's org and its `managerId` is the
 *     acting agent's manager; `type` is always `agent`. A caller cannot widen
 *     scope (the narrow `createManagedAgentSchema` also strips org/manager/type).
 *   - Client ownership (R-RUN), `maxAgents` quota, and reserved-name rules are
 *     reused from `createAgent`.
 *   - Provenance: `source = "agent-api"` (indexable) plus a `createdBy` stamp.
 *
 * Binding/starting the teammate is intentionally left to a human/daemon — v1
 * creates and records the agent; a client owner still runs it (see CLI message).
 */
export async function agentManagedAgentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/managed-agents", { config: { otelRecordBody: true } }, async (request, reply) => {
    const identity = requireAgent(request);

    const context = await agentService.getAgentProvisioningContext(app.db, identity.uuid);
    if (!context || !context.agentCapabilities.includes(AGENT_CAPABILITIES.PROVISION_AGENTS)) {
      const binName = getServerCliBinding().binName;
      throw new ForbiddenError(
        `This agent is not permitted to provision teammate agents. An organization admin must grant the ` +
          `"${AGENT_CAPABILITIES.PROVISION_AGENTS}" capability first ` +
          `(\`${binName} agent config set-capabilities <agent> ${AGENT_CAPABILITIES.PROVISION_AGENTS}\`).`,
      );
    }

    const body = createManagedAgentSchema.parse(request.body);
    const created = await agentService.createAgent(app.db, {
      ...body,
      type: AGENT_TYPES.AGENT,
      organizationId: identity.organizationId,
      managerId: context.managerId,
      source: AGENT_SOURCES.AGENT_API,
    });

    const createdBy = {
      agentId: identity.uuid,
      memberId: context.managerId,
      at: new Date().toISOString(),
    };
    await agentService.setAgentReservedMetadata(app.db, created.uuid, { createdBy });

    app.log.info(
      {
        actingAgentId: identity.uuid,
        managerId: context.managerId,
        organizationId: identity.organizationId,
        createdAgentId: created.uuid,
        clientId: created.clientId ?? null,
        source: AGENT_SOURCES.AGENT_API,
      },
      "agent self-provisioned a teammate agent",
    );

    return reply.status(201).send({
      ...created,
      metadata: agentService.stripReservedAgentMetadata(created.metadata),
      createdBy,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    });
  });
}
