import { contextEnablementHandoffQuerySchema, contextEnablementHandoffSchema } from "@first-tree/shared";
import { getServerCliBinding } from "@first-tree/shared/channel";
import type { FastifyInstance } from "fastify";
import { requireOrgMembership } from "../../scope/require-org.js";
import { getOrganization } from "../../services/organization.js";

export async function orgContextEnablementRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Params: { orgId: string };
    Querystring: { provider?: string; intent?: string };
  }>("/handoff", async (request) => {
    const scope = await requireOrgMembership(request, app.db);
    const query = contextEnablementHandoffQuerySchema.parse(request.query);
    const organization = await getOrganization(app.db, scope.organizationId);
    const executable = shellQuote(getServerCliBinding().binName);
    return contextEnablementHandoffSchema.parse({
      protocolVersion: 1,
      organizationId: scope.organizationId,
      teamDisplayName: organization.displayName,
      role: scope.role,
      provider: query.provider,
      intent: query.intent,
      command: [
        `${executable} context enable`,
        `--provider ${shellQuote(query.provider)}`,
        `--team ${shellQuote(scope.organizationId)}`,
        // Both intents run inside a non-TTY coding-agent session, where an
        // interactive plan confirmation would stall; pasting the prompt is the
        // member's acceptance of the displayed plan.
        "--yes",
      ].join(" "),
      workingDirectoryInstruction:
        "Run this once from inside the code repository where this Team's Context should be enabled; any subdirectory works.",
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
