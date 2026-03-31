import { feishuSearchQuerySchema } from "@first-tree-hub/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { adapterConfigs } from "../../db/schema/adapter-configs.js";
import { AppError } from "../../errors.js";
import { requireAgent } from "../../middleware/require-identity.js";
import { decryptFeishuCredentials, searchFeishuUsers } from "../../services/feishu/contact.js";

/** Server misconfiguration — no active Feishu bots available. */
class NoFeishuBotError extends AppError {
  constructor() {
    super(503, "No active Feishu bot is configured. Bind a Feishu bot first.");
    this.name = "NoFeishuBotError";
  }
}

export async function agentFeishuSearchRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /agent/feishu/search?q=<query>&by=<name|email|mobile>
   * Search Feishu users using any active bot's credentials.
   */
  app.get("/search", async (request) => {
    requireAgent(request);

    const query = feishuSearchQuerySchema.parse(request.query);

    // Find any active Feishu bot config
    const [botConfig] = await app.db
      .select()
      .from(adapterConfigs)
      .where(and(eq(adapterConfigs.platform, "feishu"), eq(adapterConfigs.status, "active")))
      .limit(1);

    if (!botConfig?.credentials) {
      throw new NoFeishuBotError();
    }

    const encryptionKey = app.config.secrets.encryptionKey;
    if (!encryptionKey) {
      throw new AppError(503, "ADAPTER_ENCRYPTION_KEY is not configured on the server");
    }

    const credentials = decryptFeishuCredentials(botConfig.credentials as string, encryptionKey);

    try {
      const users = await searchFeishuUsers(credentials, query.q, query.by);
      return {
        users,
        botUsed: botConfig.agentId,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Surface Feishu permission errors as 502 (upstream error) instead of 500
      throw new AppError(502, msg);
    }
  });
}
