import { and, eq, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../db/connection.js";
import { adapterConfigs } from "../db/schema/adapter-configs.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { messages } from "../db/schema/messages.js";
import { decryptCredentials } from "./crypto.js";

const OUTBOUND_BATCH_SIZE = 10;

type KaelAgentConfig = {
  configId: number;
  agentId: string;
  inboxId: string;
  kaelUserId: string;
  kaelProjectId: string;
  agentToken: string;
};

type KaelCredentials = {
  kaelUserId: string;
  kaelProjectId: string;
  agentToken: string;
};

export type KaelRuntime = {
  reload(): Promise<void>;
  processOutbound(): Promise<{ sent: number; errors: number }>;
  shutdown(): void;
};

export function createKaelRuntime(
  db: Database,
  encryptionKey: string | undefined,
  kaelEndpoint: string | undefined,
  kaelApiKey: string | undefined,
  serverUrl: string,
  log: FastifyBaseLogger,
): KaelRuntime {
  const agentConfigs = new Map<string, KaelAgentConfig>();
  const inboxToConfig = new Map<string, KaelAgentConfig>();
  let aborted = false;

  return {
    async reload(): Promise<void> {
      if (!encryptionKey) {
        log.warn("Encryption key not set — Kael runtime disabled");
        return;
      }

      if (!kaelEndpoint) {
        log.debug("KAEL_ENDPOINT not configured — Kael runtime idle");
        agentConfigs.clear();
        inboxToConfig.clear();
        return;
      }

      const configs = await db
        .select()
        .from(adapterConfigs)
        .where(and(eq(adapterConfigs.platform, "kael"), eq(adapterConfigs.status, "active")));

      // Batch-resolve agent inboxIds in one query (avoid N+1)
      const configAgentIds = configs.filter((c) => c.credentials).map((c) => c.agentId);
      const agentRows =
        configAgentIds.length > 0
          ? await db.execute<{ uuid: string; inbox_id: string }>(
              sql`SELECT uuid, inbox_id FROM agents WHERE uuid IN (${sql.join(
                configAgentIds.map((id) => sql`${id}`),
                sql`, `,
              )}) AND status = 'active'`,
            )
          : [];
      const agentInboxMap = new Map(agentRows.map((a) => [a.uuid, a.inbox_id]));

      const seen = new Set<string>();

      for (const config of configs) {
        if (!config.credentials) continue;

        let creds: KaelCredentials;
        try {
          creds = decryptCredentials(config.credentials as string, encryptionKey) as KaelCredentials;
        } catch (err) {
          log.error({ configId: config.id, err }, "Failed to decrypt Kael adapter credentials");
          continue;
        }

        seen.add(config.agentId);

        const inboxId = agentInboxMap.get(config.agentId);
        if (!inboxId) {
          log.warn({ configId: config.id, agentId: config.agentId }, "Kael config agent not found or inactive");
          continue;
        }

        const entry: KaelAgentConfig = {
          configId: config.id,
          agentId: config.agentId,
          inboxId,
          kaelUserId: creds.kaelUserId,
          kaelProjectId: creds.kaelProjectId,
          agentToken: creds.agentToken,
        };
        agentConfigs.set(config.agentId, entry);
        inboxToConfig.set(inboxId, entry);

        log.info({ configId: config.id, agentId: config.agentId }, "Loaded Kael adapter config");
      }

      // Remove configs that are no longer active
      for (const agentId of agentConfigs.keys()) {
        if (!seen.has(agentId)) {
          const old = agentConfigs.get(agentId);
          if (old) inboxToConfig.delete(old.inboxId);
          agentConfigs.delete(agentId);
          log.info({ agentId }, "Removed inactive Kael adapter config");
        }
      }
    },

    async processOutbound(): Promise<{ sent: number; errors: number }> {
      if (agentConfigs.size === 0 || !kaelEndpoint || aborted) {
        return { sent: 0, errors: 0 };
      }

      let sent = 0;
      let errorCount = 0;

      try {
        // Claim pending inbox entries for agents that have kael adapter_configs
        const agentIds = [...agentConfigs.keys()];
        const claimed = await db.execute<{
          id: number;
          inbox_id: string;
          message_id: string;
          chat_id: string | null;
        }>(sql`
          UPDATE inbox_entries
          SET status = 'delivered', delivered_at = NOW()
          WHERE id IN (
            SELECT ie.id FROM inbox_entries ie
            JOIN agents a ON ie.inbox_id = a.inbox_id
            JOIN adapter_configs ac ON a.uuid = ac.agent_id
            WHERE ac.platform = 'kael' AND ac.status = 'active'
              AND ie.status = 'pending'
              AND a.uuid IN (${sql.join(
                agentIds.map((id) => sql`${id}`),
                sql`, `,
              )})
            ORDER BY ie.created_at
            LIMIT ${OUTBOUND_BATCH_SIZE}
            FOR UPDATE OF ie SKIP LOCKED
          )
          RETURNING id, inbox_id, message_id, chat_id
        `);

        for (const entry of claimed) {
          try {
            const [msg] = await db.select().from(messages).where(eq(messages.id, entry.message_id)).limit(1);

            if (!msg) {
              await ackEntry(db, entry.id);
              continue;
            }

            // Find which agent this entry belongs to (O(1) reverse map lookup)
            const config = inboxToConfig.get(entry.inbox_id);
            if (!config) {
              await ackEntry(db, entry.id);
              continue;
            }

            // Resolve message content to string
            const messageContent = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);

            const payload = {
              hub_chat_id: entry.chat_id ?? msg.chatId,
              hub_agent_id: config.agentId,
              hub_server_url: serverUrl,
              hub_agent_token: config.agentToken,
              user_id: config.kaelUserId,
              project_id: config.kaelProjectId,
              message: messageContent,
              sender_id: msg.senderId,
              format: msg.format,
            };

            const response = await fetch(`${kaelEndpoint}/api/v1/hub/messages`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(kaelApiKey ? { "X-Internal-API-Key": kaelApiKey } : {}),
              },
              body: JSON.stringify(payload),
            });

            if (!response.ok) {
              const body = await response.text().catch(() => "");
              log.error({ entryId: entry.id, status: response.status, body }, "Kael API rejected outbound message");
              await nackEntry(db, entry.id);
              errorCount++;
              continue;
            }

            await ackEntry(db, entry.id);
            sent++;
          } catch (err) {
            log.error({ entryId: entry.id, err }, "Failed to send outbound Kael message");
            await nackEntry(db, entry.id).catch((nackErr) => {
              log.error({ entryId: entry.id, err: nackErr }, "Failed to NACK entry");
            });
            errorCount++;
          }
        }
      } catch (err) {
        log.error({ err }, "Kael outbound processing error");
        return { sent: 0, errors: 1 };
      }

      return { sent, errors: errorCount };
    },

    shutdown(): void {
      aborted = true;
      agentConfigs.clear();
      inboxToConfig.clear();
    },
  };
}

async function ackEntry(db: Database, entryId: number): Promise<void> {
  await db.update(inboxEntries).set({ status: "acked", ackedAt: new Date() }).where(eq(inboxEntries.id, entryId));
}

const MAX_RETRY_COUNT = 3;

async function nackEntry(db: Database, entryId: number): Promise<void> {
  // Atomic: increment retry_count and set status in one UPDATE (no TOCTOU race)
  await db.execute(sql`
    UPDATE inbox_entries
    SET
      status = CASE WHEN retry_count >= ${MAX_RETRY_COUNT} THEN 'failed' ELSE 'pending' END,
      retry_count = retry_count + 1
    WHERE id = ${entryId}
  `);
}
