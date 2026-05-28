import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterManager } from "../services/adapter-manager.js";
import { createBackgroundTasks } from "../services/background-tasks.js";
import * as chatArchiveService from "../services/chat-archive.js";
import * as clientService from "../services/client.js";
import * as inboxService from "../services/inbox.js";
import type { KaelRuntime } from "../services/kael-runtime.js";
import * as notificationService from "../services/notification.js";
import * as presenceService from "../services/presence.js";

function createApp(): FastifyInstance {
  const app = {
    db: {},
    config: {
      runtime: {
        inboxTimeoutSeconds: 60,
        maxRetryCount: 3,
        presenceCleanupSeconds: 30,
        archiveSweepIntervalSeconds: 60,
        archiveMappedIdleSeconds: 3600,
        archiveUnmappedIdleSeconds: 43_200,
      },
    },
  };
  // Test double implements the fields createBackgroundTasks reads.
  return app as unknown as FastifyInstance;
}

function createAdapter(): AdapterManager {
  const adapter = {
    reload: vi.fn(async () => {}),
    processOutbound: vi.fn(async () => ({ sent: 1, errors: 0 })),
    editOutboundMessage: vi.fn(async () => true),
    getBotStatuses: vi.fn(() => []),
    shutdown: vi.fn(),
  };
  // Test double implements the AdapterManager methods used here.
  return adapter as unknown as AdapterManager;
}

function createKael(): KaelRuntime {
  return {
    reload: vi.fn(async () => {}),
    processOutbound: vi.fn(async () => ({ sent: 1, errors: 0 })),
    shutdown: vi.fn(),
  };
}

describe("createBackgroundTasks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(inboxService, "resetTimedOutEntries").mockResolvedValue({ failed: 0, reset: 0 });
    vi.spyOn(inboxService, "pruneStaleSilentEntries").mockResolvedValue({
      ackedDeleted: 2,
      stalePendingDeleted: 1,
    });
    vi.spyOn(presenceService, "heartbeatInstance").mockResolvedValue();
    vi.spyOn(presenceService, "cleanupStalePresence").mockResolvedValue(0);
    vi.spyOn(presenceService, "markStaleAgents").mockResolvedValue(["agent-1"]);
    vi.spyOn(clientService, "cleanupStaleClients").mockResolvedValue(0);
    vi.spyOn(notificationService, "notifyAgentEvent").mockResolvedValue();
    vi.spyOn(chatArchiveService, "sweepChatArchive").mockResolvedValue({
      mappedRowsArchived: 1,
      unmappedRowsArchived: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts scheduled tasks, runs initial reloads, and stops timers", async () => {
    const app = createApp();
    const adapter = createAdapter();
    const kael = createKael();
    const tasks = createBackgroundTasks(app, "instance-1", adapter, kael);

    tasks.start();
    await Promise.resolve();

    expect(presenceService.heartbeatInstance).toHaveBeenCalledWith(app.db, "instance-1");
    expect(adapter.reload).toHaveBeenCalledTimes(1);
    expect(kael.reload).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(adapter.processOutbound).toHaveBeenCalledTimes(1);
    expect(kael.processOutbound).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(presenceService.cleanupStalePresence).toHaveBeenCalledWith(app.db, 30);
    expect(clientService.cleanupStaleClients).toHaveBeenCalledWith(app.db, 30);
    expect(notificationService.notifyAgentEvent).toHaveBeenCalledWith(app.db, "agent-1", "agent_stale", "medium");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(inboxService.resetTimedOutEntries).toHaveBeenCalledWith(app.db, 60, 3);
    expect(inboxService.pruneStaleSilentEntries).toHaveBeenCalledWith(app.db);
    expect(chatArchiveService.sweepChatArchive).toHaveBeenCalledWith(app.db, {
      mappedIdleSeconds: 3600,
      unmappedIdleSeconds: 43_200,
    });

    const outboundCalls = vi.mocked(adapter.processOutbound).mock.calls.length;
    tasks.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(adapter.processOutbound).toHaveBeenCalledTimes(outboundCalls);
  });

  it("supports disabled archive sweep and absent Kael runtime", async () => {
    const app = createApp();
    app.config.runtime.archiveSweepIntervalSeconds = 0;
    const adapter = createAdapter();
    const tasks = createBackgroundTasks(app, "instance-1", adapter);

    tasks.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(adapter.processOutbound).toHaveBeenCalledTimes(1);
    expect(chatArchiveService.sweepChatArchive).not.toHaveBeenCalled();

    tasks.stop();
  });
});
