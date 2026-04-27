import type { FastifyInstance } from "fastify";
import { createLogger } from "../observability/index.js";
import type { AdapterManager } from "./adapter-manager.js";
import * as clientService from "./client.js";
import * as inboxService from "./inbox.js";
import type { KaelRuntime } from "./kael-runtime.js";
import * as notificationService from "./notification.js";
import * as presenceService from "./presence.js";
import * as systemConfigService from "./system-config.js";

const log = createLogger("BackgroundTasks");

export type BackgroundTasks = {
  start(): void;
  stop(): void;
};

export function createBackgroundTasks(
  app: FastifyInstance,
  instanceId: string,
  adapterManager: AdapterManager,
  kaelRuntime?: KaelRuntime,
): BackgroundTasks {
  let inboxTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let adapterOutboundTimer: ReturnType<typeof setInterval> | null = null;
  let kaelOutboundTimer: ReturnType<typeof setInterval> | null = null;

  return {
    start() {
      // Inbox timeout reset — runs every 60 seconds
      inboxTimer = setInterval(async () => {
        try {
          const configs = await systemConfigService.getAllConfigs(app.db);
          const timeoutSeconds = (configs.inbox_timeout_seconds as number) ?? 300;
          const maxRetries = (configs.max_retry_count as number) ?? 3;
          await inboxService.resetTimedOutEntries(app.db, timeoutSeconds, maxRetries);
          // Silent row GC piggy-backs on the inbox timer (no need for a
          // second timer — DELETE is rare and tiny). Uses default 30-day
          // window for stale-pending; acked rows are deleted regardless of
          // age (they've fulfilled their context-replay purpose). See
          // pruneStaleSilentEntries jsdoc.
          const pruned = await inboxService.pruneStaleSilentEntries(app.db);
          if (pruned.ackedDeleted > 0 || pruned.stalePendingDeleted > 0) {
            log.debug(
              { ackedDeleted: pruned.ackedDeleted, stalePendingDeleted: pruned.stalePendingDeleted },
              "pruned silent inbox rows",
            );
          }
        } catch (err) {
          log.error({ err }, "failed to reset timed-out inbox entries");
        }
      }, 60_000);

      // Server instance heartbeat — runs every 30 seconds
      heartbeatTimer = setInterval(async () => {
        try {
          await presenceService.heartbeatInstance(app.db, instanceId);
          const configs = await systemConfigService.getAllConfigs(app.db);
          const staleSeconds = (configs.presence_cleanup_seconds as number) ?? 60;
          await presenceService.cleanupStalePresence(app.db, staleSeconds);
          await clientService.cleanupStaleClients(app.db, staleSeconds);
          // M1: per-agent heartbeat staleness detection
          const staleAgents = await presenceService.markStaleAgents(app.db, staleSeconds);
          if (staleAgents.length > 0) {
            log.info({ count: staleAgents.length, agentIds: staleAgents }, "marked agents as stale");
            // M1: Create notifications for stale agents. Message text is
            // composed inside notifyAgentEvent so phrasing (computer hostname
            // vs agent name) stays consistent across event sources.
            for (const agentId of staleAgents) {
              notificationService.notifyAgentEvent(app.db, agentId, "agent_stale", "medium").catch(() => {});
            }
          }
        } catch (err) {
          log.error({ err }, "failed to heartbeat / cleanup presence");
        }
      }, 30_000);

      // Adapter outbound processing — runs every 5 seconds
      adapterOutboundTimer = setInterval(async () => {
        try {
          await adapterManager.processOutbound();
        } catch (err) {
          log.error({ err }, "adapter outbound processing failed");
        }
      }, 5_000);

      // Kael outbound processing — runs every 5 seconds
      if (kaelRuntime) {
        kaelOutboundTimer = setInterval(async () => {
          try {
            await kaelRuntime.processOutbound();
          } catch (err) {
            log.error({ err }, "kael outbound processing failed");
          }
        }, 5_000);
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
      if (adapterOutboundTimer) {
        clearInterval(adapterOutboundTimer);
        adapterOutboundTimer = null;
      }
      if (kaelOutboundTimer) {
        clearInterval(kaelOutboundTimer);
        kaelOutboundTimer = null;
      }
    },
  };
}
