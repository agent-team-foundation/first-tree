import {
  dryRunAgentRuntimeConfigSchema,
  updateAgentRuntimeConfigSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { requireMember } from "../../middleware/require-identity.js";
import { assertCanManage, memberScope } from "../../services/access-control.js";

export async function adminAgentConfigRoutes(app: FastifyInstance): Promise<void> {
  // Runtime config is behavior-sensitive (system prompt, tools, env — the
  // agent's "soul"). Visibility controls whether a member sees the agent
  // exists; manageability controls whether they can inspect its behavior.
  // This mirrors how public GPTs / bots across the industry expose a card
  // view but keep the prompt private.
  //   GET  /:uuid         → assertAgentVisible (card view in agents.ts)
  //   GET  /:uuid/config  → assertCanManage    (this file, all three routes)
  app.get<{ Params: { uuid: string } }>("/:uuid/config", async (request) => {
    await assertCanManage(app.db, memberScope(request), request.params.uuid);
    const cfg = await app.configService.get(request.params.uuid);
    return cfg;
  });

  app.patch<{ Params: { uuid: string } }>("/:uuid/config", { config: { otelRecordBody: true } }, async (request) => {
    const member = requireMember(request);
    await assertCanManage(app.db, memberScope(request), request.params.uuid);
    const body = updateAgentRuntimeConfigSchema.parse(request.body);
    const updated = await app.configService.update(request.params.uuid, body, member.memberId);
    return updated;
  });

  app.post<{ Params: { uuid: string } }>(
    "/:uuid/config/dry-run",
    { config: { otelRecordBody: true } },
    async (request) => {
      await assertCanManage(app.db, memberScope(request), request.params.uuid);
      const body = dryRunAgentRuntimeConfigSchema.parse(request.body);
      const result = await app.configService.dryRun(request.params.uuid, body.payload);
      return result;
    },
  );
}
