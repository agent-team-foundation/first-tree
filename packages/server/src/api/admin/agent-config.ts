import {
  dryRunAgentRuntimeConfigSchema,
  updateAgentRuntimeConfigSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { requireMember } from "../../middleware/require-identity.js";
import { assertAgentVisible, assertCanManage, memberScope } from "../../services/access-control.js";

export async function adminAgentConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { uuid: string } }>("/:uuid/config", async (request) => {
    const scope = memberScope(request);
    await assertAgentVisible(app.db, scope, request.params.uuid);
    const cfg = await app.configService.get(request.params.uuid);
    return cfg;
  });

  app.patch<{ Params: { uuid: string } }>("/:uuid/config", async (request) => {
    const member = requireMember(request);
    await assertCanManage(app.db, memberScope(request), request.params.uuid);
    const body = updateAgentRuntimeConfigSchema.parse(request.body);
    const updated = await app.configService.update(request.params.uuid, body, member.memberId);
    return updated;
  });

  app.post<{ Params: { uuid: string } }>("/:uuid/config/dry-run", async (request) => {
    await assertCanManage(app.db, memberScope(request), request.params.uuid);
    const body = dryRunAgentRuntimeConfigSchema.parse(request.body);
    const result = await app.configService.dryRun(request.params.uuid, body.payload);
    return result;
  });
}
