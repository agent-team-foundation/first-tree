import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapState, markReady, markStage } from "../bootstrap-state.js";
import type { BotStatus } from "../services/adapter-manager.js";
import { useTestApp } from "./helpers.js";

/**
 * `/readyz` reads the process-scoped `bootstrapState`. Tests must reset the
 * relevant slice so order-independent runs see a clean baseline — the test
 * runner re-uses worker processes (vitest `isolate: false`).
 */
function resetState() {
  for (const key of Object.keys(bootstrapState.stages)) {
    delete bootstrapState.stages[key];
  }
  bootstrapState.readyAt = null;
}

function markAllStagesDone() {
  markStage("initTelemetry", { status: "done", durationMs: 1 });
  markStage("runMigrations", { status: "done", durationMs: 1 });
  markStage("buildApp", { status: "done", durationMs: 1 });
  markStage("appListen", { status: "done", durationMs: 1 });
}

describe("/readyz", () => {
  const getApp = useTestApp();

  beforeEach(() => {
    resetState();
  });
  afterEach(() => {
    resetState();
  });

  it("returns 503 with stage detail when stages have not been marked done", async () => {
    const res = await getApp().inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.readyAt).toBeNull();
    expect(body.stages).toEqual({});
    expect(Array.isArray(body.adapters)).toBe(true);
  });

  it("returns 200 when all stages done, readyAt set, and no adapter bots active", async () => {
    markAllStagesDone();
    markReady();

    const res = await getApp().inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(true);
    expect(body.readyAt).toBeTruthy();
    expect(body.stages.appListen?.status).toBe("done");
  });

  it("returns 503 when any required stage failed", async () => {
    markAllStagesDone();
    markStage("runMigrations", { status: "failed", error: "boom" });
    markReady();

    const res = await getApp().inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.stages.runMigrations?.status).toBe("failed");
    expect(body.stages.runMigrations?.error).toBe("boom");
  });

  it("returns 503 when stages done but markReady has not been called", async () => {
    markAllStagesDone();
    // readyAt left null on purpose

    const res = await getApp().inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().ready).toBe(false);
  });

  describe("adapter connectivity gating", () => {
    function stubBotStatuses(statuses: BotStatus[]) {
      // Replace the live getBotStatuses with a stub; restore between cases
      // so other adapter behavior isn't affected.
      return vi.spyOn(getApp().adapterManager, "getBotStatuses").mockReturnValue(statuses);
    }

    it("returns 503 when all required stages done but some adapter bot is disconnected", async () => {
      markAllStagesDone();
      markReady();
      const spy = stubBotStatuses([
        {
          configId: 1,
          platform: "feishu",
          agentId: "agent-a",
          appId: "cli_a",
          connected: true,
          lastError: null,
          lastActiveAt: null,
        },
        {
          configId: 2,
          platform: "feishu",
          agentId: "agent-b",
          appId: "cli_b",
          connected: false,
          lastError: "feishu ws.start timeout after 8000ms for cli_b",
          lastActiveAt: null,
        },
      ]);

      try {
        const res = await getApp().inject({ method: "GET", url: "/readyz" });
        expect(res.statusCode).toBe(503);
        const body = res.json();
        expect(body.ready).toBe(false);
        expect(body.adapters).toHaveLength(2);
        expect(body.adapters[1].connected).toBe(false);
        expect(body.adapters[1].lastError).toMatch(/timeout/);
      } finally {
        spy.mockRestore();
      }
    });

    it("returns 503 when every adapter bot is disconnected even with stages done", async () => {
      markAllStagesDone();
      markReady();
      const spy = stubBotStatuses([
        {
          configId: 1,
          platform: "feishu",
          agentId: "agent-a",
          appId: "cli_a",
          connected: false,
          lastError: "boom",
          lastActiveAt: null,
        },
      ]);

      try {
        const res = await getApp().inject({ method: "GET", url: "/readyz" });
        expect(res.statusCode).toBe(503);
        const body = res.json();
        expect(body.ready).toBe(false);
        expect(body.adapters[0].connected).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it("returns 200 when stages done, readyAt set, and every adapter bot is connected", async () => {
      markAllStagesDone();
      markReady();
      const spy = stubBotStatuses([
        {
          configId: 1,
          platform: "feishu",
          agentId: "agent-a",
          appId: "cli_a",
          connected: true,
          lastError: null,
          lastActiveAt: new Date().toISOString(),
        },
      ]);

      try {
        const res = await getApp().inject({ method: "GET", url: "/readyz" });
        expect(res.statusCode).toBe(200);
        expect(res.json().ready).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
