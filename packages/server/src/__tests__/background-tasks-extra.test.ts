import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerMocks = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
};

const serviceMocks = {
  cleanupStaleClients: vi.fn(),
  cleanupStalePresence: vi.fn(),
  heartbeatInstance: vi.fn(),
  markStaleAgents: vi.fn(),
  notifyAgentEvent: vi.fn(),
  pruneStaleSilentEntries: vi.fn(),
  sweepChatArchive: vi.fn(),
  sweepExpiredEventClaims: vi.fn(),
};

const mockedModules = [
  "../observability/index.js",
  "../services/chat-archive.js",
  "../services/client.js",
  "../services/event-dedup.js",
  "../services/inbox.js",
  "../services/notification.js",
  "../services/presence.js",
];

function mockBackgroundTaskDependencies(): void {
  vi.doMock("../observability/index.js", () => ({
    createLogger: () => loggerMocks,
  }));
  vi.doMock("../services/chat-archive.js", () => ({
    sweepChatArchive: serviceMocks.sweepChatArchive,
  }));
  vi.doMock("../services/client.js", () => ({
    cleanupStaleClients: serviceMocks.cleanupStaleClients,
  }));
  vi.doMock("../services/event-dedup.js", () => ({
    sweepExpiredEventClaims: serviceMocks.sweepExpiredEventClaims,
  }));
  vi.doMock("../services/inbox.js", () => ({
    pruneStaleSilentEntries: serviceMocks.pruneStaleSilentEntries,
  }));
  vi.doMock("../services/notification.js", () => ({
    notifyAgentEvent: serviceMocks.notifyAgentEvent,
  }));
  vi.doMock("../services/presence.js", () => ({
    cleanupStalePresence: serviceMocks.cleanupStalePresence,
    heartbeatInstance: serviceMocks.heartbeatInstance,
    markStaleAgents: serviceMocks.markStaleAgents,
  }));
}

function makeApp(archiveSweepIntervalSeconds = 30): FastifyInstance {
  return {
    config: {
      cronJobs: {
        enabled: false,
      },
      runtime: {
        archiveMappedIdleSeconds: 3_600,
        archiveSweepIntervalSeconds,
        presenceCleanupSeconds: 60,
        pollingIntervalSeconds: 5,
      },
    },
    db: { name: "db" },
  } as unknown as FastifyInstance;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.clearAllMocks();
  mockBackgroundTaskDependencies();
  serviceMocks.cleanupStaleClients.mockResolvedValue(undefined);
  serviceMocks.cleanupStalePresence.mockResolvedValue(undefined);
  serviceMocks.heartbeatInstance.mockResolvedValue(undefined);
  serviceMocks.markStaleAgents.mockResolvedValue([]);
  serviceMocks.notifyAgentEvent.mockResolvedValue(undefined);
  serviceMocks.pruneStaleSilentEntries.mockResolvedValue({ ackedDeleted: 0, stalePendingDeleted: 0 });
  serviceMocks.sweepChatArchive.mockResolvedValue({ mappedRowsArchived: 0, unmappedRowsArchived: 0 });
  serviceMocks.sweepExpiredEventClaims.mockResolvedValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  for (const moduleId of mockedModules) {
    vi.doUnmock(moduleId);
  }
  vi.resetModules();
});

describe("createBackgroundTasks", () => {
  it("runs heartbeat, inbox prune, archive sweep, and stale-agent notification intervals", async () => {
    const { createBackgroundTasks } = await import("../services/background-tasks.js");
    serviceMocks.pruneStaleSilentEntries.mockResolvedValue({ ackedDeleted: 2, stalePendingDeleted: 1 });
    serviceMocks.markStaleAgents.mockResolvedValue(["agent_1", "agent_2"]);
    serviceMocks.sweepChatArchive.mockResolvedValue({ mappedRowsArchived: 1, unmappedRowsArchived: 1 });
    serviceMocks.sweepExpiredEventClaims.mockResolvedValue(3);
    const app = makeApp(30);
    const tasks = createBackgroundTasks(app, "srv_1");

    tasks.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(serviceMocks.heartbeatInstance).toHaveBeenCalledWith(app.db, "srv_1");
    expect(serviceMocks.cleanupStalePresence).toHaveBeenCalledWith(app.db, 60);
    expect(serviceMocks.cleanupStaleClients).toHaveBeenCalledWith(app.db, 60);
    expect(serviceMocks.pruneStaleSilentEntries).toHaveBeenCalledWith(app.db);
    expect(serviceMocks.sweepChatArchive).toHaveBeenCalledWith(app.db, { mappedIdleSeconds: 3_600 });
    expect(serviceMocks.notifyAgentEvent).toHaveBeenCalledWith(app.db, "agent_1", "agent_stale", "medium");
    expect(serviceMocks.notifyAgentEvent).toHaveBeenCalledWith(app.db, "agent_2", "agent_stale", "medium");
    expect(loggerMocks.debug).toHaveBeenCalledWith(
      { ackedDeleted: 2, stalePendingDeleted: 1 },
      "pruned silent inbox rows",
    );
    expect(loggerMocks.info).toHaveBeenCalledWith(
      { agentIds: ["agent_1", "agent_2"], count: 2 },
      "marked agents as stale",
    );
    expect(loggerMocks.info).toHaveBeenCalledWith(
      { mappedRowsArchived: 1, unmappedRowsArchived: 1 },
      "chat auto-archive sweep flipped rows to archived",
    );
    expect(serviceMocks.sweepExpiredEventClaims).toHaveBeenCalledWith(app.db);
    expect(loggerMocks.info).toHaveBeenCalledWith({ swept: 3 }, "swept expired pending webhook event claims");

    await tasks.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs timer errors, catches rejected notifications, and allows archive sweep disablement", async () => {
    const { createBackgroundTasks } = await import("../services/background-tasks.js");
    serviceMocks.heartbeatInstance.mockRejectedValueOnce(new Error("initial heartbeat failed"));
    serviceMocks.pruneStaleSilentEntries.mockRejectedValueOnce(new Error("prune failed"));
    serviceMocks.heartbeatInstance
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("heartbeat failed"));
    serviceMocks.notifyAgentEvent.mockRejectedValueOnce(new Error("notify failed"));
    serviceMocks.sweepExpiredEventClaims.mockRejectedValueOnce(new Error("claim sweep failed"));
    const app = makeApp(0);
    const tasks = createBackgroundTasks(app, "srv_2");

    tasks.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(serviceMocks.sweepChatArchive).not.toHaveBeenCalled();
    expect(loggerMocks.error).toHaveBeenCalledWith({ err: expect.any(Error) }, "failed initial heartbeat");
    expect(loggerMocks.error).toHaveBeenCalledWith({ err: expect.any(Error) }, "failed to prune silent inbox rows");
    expect(loggerMocks.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      "failed to heartbeat / cleanup presence",
    );
    expect(loggerMocks.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      "failed to sweep expired webhook event claims",
    );

    await tasks.stop();
  });
});
