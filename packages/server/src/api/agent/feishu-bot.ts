import { selfServiceFeishuBotSchema } from "@first-tree-hub/shared";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../../errors.js";
import { requireAgent } from "../../middleware/require-identity.js";
import * as adapterService from "../../services/adapter.js";
import * as agentService from "../../services/agent.js";

export async function agentFeishuBotRoutes(app: FastifyInstance): Promise<void> {
  /**
   * PUT /agent/me/feishu-bot
   * Self-service: agent binds its own Feishu bot (upsert).
   */
  app.put("/me/feishu-bot", async (request, reply) => {
    const identity = requireAgent(request);
    const body = selfServiceFeishuBotSchema.parse(request.body);

    // Verify agent is not human
    const agent = await agentService.getAgent(app.db, identity.id);
    if (agent.type === "human") {
      throw new BadRequestError("Human agents cannot bind Feishu bots. Use bind-user instead.");
    }

    // Try update existing, otherwise create
    const existing = await adapterService.listAdapterConfigs(app.db);
    const current = existing.find((c) => c.agentId === identity.id && c.platform === "feishu");

    let config: Awaited<ReturnType<typeof adapterService.updateAdapterConfig>>;
    if (current) {
      config = await adapterService.updateAdapterConfig(
        app.db,
        current.id,
        { credentials: { app_id: body.appId, app_secret: body.appSecret }, status: "active" },
        app.config.secrets.encryptionKey,
      );
    } else {
      config = await adapterService.createAdapterConfig(
        app.db,
        {
          platform: "feishu",
          agentId: identity.id,
          credentials: { app_id: body.appId, app_secret: body.appSecret },
          status: "active",
        },
        app.config.secrets.encryptionKey,
      );
    }

    // Trigger adapter reload
    app.adapterManager.reload().catch((err) => app.log.error(err, "Adapter reload failed after self-service bind"));
    app.notifier.notifyConfigChange("adapter_configs").catch(() => {});

    return reply.status(current ? 200 : 201).send({
      ...config,
      createdAt: config.createdAt.toISOString(),
      updatedAt: config.updatedAt.toISOString(),
    });
  });

  /**
   * DELETE /agent/me/feishu-bot
   * Self-service: agent unbinds its own Feishu bot.
   */
  app.delete("/me/feishu-bot", async (request, reply) => {
    const identity = requireAgent(request);

    const existing = await adapterService.listAdapterConfigs(app.db);
    const current = existing.find((c) => c.agentId === identity.id && c.platform === "feishu");

    if (!current) {
      return reply.status(204).send();
    }

    await adapterService.deleteAdapterConfig(app.db, current.id);
    app.adapterManager.reload().catch((err) => app.log.error(err, "Adapter reload failed after self-service unbind"));
    app.notifier.notifyConfigChange("adapter_configs").catch(() => {});

    return reply.status(204).send();
  });
}
