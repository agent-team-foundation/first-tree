import type { FastifyInstance } from "fastify";
import type { AdapterManager } from "./adapter-manager.js";
import * as inboxService from "./inbox.js";
import type { KaelRuntime } from "./kael-runtime.js";
import * as presenceService from "./presence.js";
import * as systemConfigService from "./system-config.js";

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
        } catch (err) {
          app.log.error(err, "Failed to reset timed-out inbox entries");
        }
      }, 60_000);

      // Server instance heartbeat — runs every 30 seconds
      heartbeatTimer = setInterval(async () => {
        try {
          await presenceService.heartbeatInstance(app.db, instanceId);
          const configs = await systemConfigService.getAllConfigs(app.db);
          const staleSeconds = (configs.presence_cleanup_seconds as number) ?? 60;
          await presenceService.cleanupStalePresence(app.db, staleSeconds);
        } catch (err) {
          app.log.error(err, "Failed to heartbeat / cleanup presence");
        }
      }, 30_000);

      // Adapter outbound processing — runs every 5 seconds
      adapterOutboundTimer = setInterval(async () => {
        try {
          await adapterManager.processOutbound();
        } catch (err) {
          app.log.error(err, "Adapter outbound processing failed");
        }
      }, 5_000);

      // Kael outbound processing — runs every 5 seconds
      if (kaelRuntime) {
        kaelOutboundTimer = setInterval(async () => {
          try {
            await kaelRuntime.processOutbound();
          } catch (err) {
            app.log.error(err, "Kael outbound processing failed");
          }
        }, 5_000);
      }

      // Initial heartbeat
      presenceService.heartbeatInstance(app.db, instanceId).catch((err) => {
        app.log.error(err, "Failed initial heartbeat");
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
