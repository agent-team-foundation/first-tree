import { AGENT_SELECTOR_HEADER, setAgentCapabilitiesSchema } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { ForbiddenError } from "../errors.js";
import { requireAgentAccess } from "../scope/require-resource.js";
import * as agentService from "../services/agent.js";

/**
 * Class C — `/api/v1/agents/:uuid/capabilities`. The operator (human) surface
 * for granting/revoking per-agent capabilities (issue #1885).
 *
 * `agentCapabilities` and `createdBy` are reserved metadata (write-protected on
 * the free-form `metadata` field, and stripped from the public agent
 * projection), so this dedicated pair is the deliberate read/write path:
 *
 *   GET   /agents/:uuid/capabilities — read the grant (+ provenance for admins)
 *   PATCH /agents/:uuid/capabilities — replace the grant (admin only)
 *
 * The grant is admin-only, consistent with manager-reassignment: an agent runs
 * with its managing member's JWT, so a mere `manage`-scope grant would let an
 * agent self-grant. We additionally reject any request carrying `X-Agent-Id`
 * (defense-in-depth: an SDK-mediated agent call cannot reach the grant), while
 * being honest that a hand-crafted header-less admin-JWT call is
 * indistinguishable from a human admin — the residual root finding.
 */
export async function agentCapabilitiesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { uuid: string } }>("/:uuid/capabilities", async (request) => {
    const { scope } = await requireAgentAccess(request, app.db, "manage");
    const context = await agentService.getAgentProvisioningContext(app.db, request.params.uuid);
    const isAdmin = scope.role === "admin";
    return {
      agentId: request.params.uuid,
      agentCapabilities: context?.agentCapabilities ?? [],
      // Provenance is admin-only; a non-admin manager sees the grant but not
      // who provisioned the agent.
      createdBy: isAdmin ? (context?.createdBy ?? null) : undefined,
    };
  });

  app.patch<{ Params: { uuid: string } }>(
    "/:uuid/capabilities",
    { config: { otelRecordBody: true } },
    async (request) => {
      // Defense-in-depth: funnel SDK-mediated agents away from the grant path.
      if (request.headers?.[AGENT_SELECTOR_HEADER]) {
        throw new ForbiddenError(
          "Granting agent capabilities is an operator action and cannot be performed from inside a running agent session.",
        );
      }
      const { scope } = await requireAgentAccess(request, app.db, "manage");
      if (scope.role !== "admin") {
        throw new ForbiddenError("Only an organization admin can grant or revoke agent capabilities.");
      }
      const body = setAgentCapabilitiesSchema.parse(request.body);
      await agentService.setAgentReservedMetadata(app.db, request.params.uuid, {
        agentCapabilities: body.capabilities,
      });
      const context = await agentService.getAgentProvisioningContext(app.db, request.params.uuid);
      app.log.info(
        { agentId: request.params.uuid, grantedByMemberId: scope.memberId, capabilities: body.capabilities },
        "agent capabilities updated",
      );
      return {
        agentId: request.params.uuid,
        agentCapabilities: context?.agentCapabilities ?? [],
        createdBy: context?.createdBy ?? null,
      };
    },
  );
}
