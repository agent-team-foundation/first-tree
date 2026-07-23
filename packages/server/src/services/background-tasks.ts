import type { FastifyInstance } from "fastify";
import { createLogger } from "../observability/index.js";
import * as chatArchiveService from "./chat-archive.js";
import * as clientService from "./client.js";
import * as eventDedupService from "./event-dedup.js";
import * as inboxService from "./inbox.js";
import * as notificationService from "./notification.js";
import * as presenceService from "./presence.js";

const log = createLogger("BackgroundTasks");

export type BackgroundTasks = {
  start(): void;
  stop(): void;
};

export function createBackgroundTasks(app: FastifyInstance, instanceId: string): BackgroundTasks {
  let inboxTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let archiveSweepTimer: ReturnType<typeof setInterval> | null = null;
  let webhookClaimSweepTimer: ReturnType<typeof setInterval> | null = null;

  return {
    start() {
      // Silent inbox row GC — runs every 60 seconds. Acked silent rows are
      // deleted regardless of age (they've fulfilled their context-replay
      // purpose); stale `pending` silent rows are deleted after the default
      // 30-day window. The legacy 300s delivered-timeout reset that used to
      // live here was removed once `agent:bind` became the sole recovery
      // entrypoint for in-flight messages (see
      // docs/inflight-message-recovery-design.md §4).
      inboxTimer = setInterval(async () => {
        try {
          const pruned = await inboxService.pruneStaleSilentEntries(app.db);
          if (pruned.ackedDeleted > 0 || pruned.stalePendingDeleted > 0) {
            log.debug(
              { ackedDeleted: pruned.ackedDeleted, stalePendingDeleted: pruned.stalePendingDeleted },
              "pruned silent inbox rows",
            );
          }
        } catch (err) {
          log.error({ err }, "failed to prune silent inbox rows");
        }
      }, 60_000);

      // Server instance heartbeat — runs every 30 seconds
      heartbeatTimer = setInterval(async () => {
        try {
          await presenceService.heartbeatInstance(app.db, instanceId);
          const staleSeconds = app.config.runtime.presenceCleanupSeconds;
          await presenceService.cleanupStalePresence(app.db, staleSeconds);
          await clientService.cleanupStaleClients(app.db, staleSeconds);
          // Per-agent heartbeat staleness detection. Message text is composed
          // inside notifyAgentEvent so phrasing (computer hostname vs agent
          // name) stays consistent across event sources.
          const staleAgents = await presenceService.markStaleAgents(app.db, staleSeconds);
          if (staleAgents.length > 0) {
            log.info({ count: staleAgents.length, agentIds: staleAgents }, "marked agents as stale");
            for (const agentId of staleAgents) {
              notificationService.notifyAgentEvent(app.db, agentId, "agent_stale", "medium").catch(() => {});
            }
          }
        } catch (err) {
          log.error({ err }, "failed to heartbeat / cleanup presence");
        }
      }, 30_000);

      // Chat auto-archive sweeper — cadence comes from runtime config so
      // ops can tune (or zero-disable) without touching code. See
      // services/chat-archive.ts for the SCM-source archive policy and
      // idle threshold (default: 1h).
      const archiveSweepSeconds = app.config.runtime.archiveSweepIntervalSeconds;
      if (archiveSweepSeconds > 0) {
        archiveSweepTimer = setInterval(async () => {
          try {
            const stats = await chatArchiveService.sweepChatArchive(app.db, {
              mappedIdleSeconds: app.config.runtime.archiveMappedIdleSeconds,
            });
            if (stats.mappedRowsArchived > 0 || stats.unmappedRowsArchived > 0) {
              log.info(stats, "chat auto-archive sweep flipped rows to archived");
            }
          } catch (err) {
            log.error({ err }, "chat auto-archive sweep failed");
          }
        }, archiveSweepSeconds * 1000);
      }

      // Webhook claim hygiene sweep — cadence comes from runtime config so
      // ops (and tests) can tune or zero-disable it. Recovery of crashed
      // webhook attempts never depends on this sweep — expired pending
      // claims are taken over inline by the next redelivery — it only
      // deletes long-expired pending rows nobody redelivered. See
      // services/event-dedup.ts for the claim state machine and the
      // deletion grace period.
      const webhookClaimSweepSeconds = app.config.runtime.webhookClaimSweepIntervalSeconds;
      if (webhookClaimSweepSeconds > 0) {
        webhookClaimSweepTimer = setInterval(async () => {
          try {
            const swept = await eventDedupService.sweepExpiredWebhookClaims(app.db);
            if (swept > 0) {
              log.info({ swept }, "webhook claim sweep deleted stale pending claims");
            }
          } catch (err) {
            log.error({ err }, "webhook claim sweep failed");
          }
        }, webhookClaimSweepSeconds * 1000);
      }

      // Initial heartbeat
      presenceService.heartbeatInstance(app.db, instanceId).catch((err) => {
        log.error({ err }, "failed initial heartbeat");
      });
    },

    stop() {
      if (inboxTimer) {
        clearInterval(inboxTimer);
        inboxTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (archiveSweepTimer) {
        clearInterval(archiveSweepTimer);
        archiveSweepTimer = null;
      }
      if (webhookClaimSweepTimer) {
        clearInterval(webhookClaimSweepTimer);
        webhookClaimSweepTimer = null;
      }
    },
  };
}
