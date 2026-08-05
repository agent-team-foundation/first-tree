import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapState, markReady, markStage } from "../bootstrap-state.js";
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
    vi.restoreAllMocks();
    resetState();
  });

  it("returns 503 with unchecked database state and skips the probe before bootstrap completes", async () => {
    const check = vi
      .spyOn(getApp().databaseReadinessProbe, "check")
      .mockRejectedValue(new Error("readiness probe must not run"));

    const res = await getApp().inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      ready: false,
      db: "unchecked",
      startedAt: bootstrapState.startedAt.toISOString(),
      readyAt: null,
      stages: {},
    });
    expect(check).not.toHaveBeenCalled();
  });

  it("returns 200 with connected database state after bootstrap completes", async () => {
    markAllStagesDone();
    markReady();
    const check = vi.spyOn(getApp().databaseReadinessProbe, "check").mockResolvedValue("connected");

    const res = await getApp().inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ready: true,
      db: "connected",
      startedAt: bootstrapState.startedAt.toISOString(),
      readyAt: bootstrapState.readyAt?.toISOString(),
      stages: bootstrapState.stages,
    });
    expect(check).toHaveBeenCalledOnce();
  });

  it("returns 503 with unchecked database state and skips the probe when bootstrap failed", async () => {
    markAllStagesDone();
    markStage("runMigrations", { status: "failed", error: "boom" });
    markReady();
    const check = vi
      .spyOn(getApp().databaseReadinessProbe, "check")
      .mockRejectedValue(new Error("readiness probe must not run"));

    const res = await getApp().inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      ready: false,
      db: "unchecked",
      startedAt: bootstrapState.startedAt.toISOString(),
      readyAt: bootstrapState.readyAt?.toISOString(),
      stages: bootstrapState.stages,
    });
    expect(check).not.toHaveBeenCalled();
  });

  it("returns 503 when stages done but markReady has not been called", async () => {
    markAllStagesDone();
    // readyAt left null on purpose
    const check = vi
      .spyOn(getApp().databaseReadinessProbe, "check")
      .mockRejectedValue(new Error("readiness probe must not run"));

    const res = await getApp().inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      ready: false,
      db: "unchecked",
      startedAt: bootstrapState.startedAt.toISOString(),
      readyAt: null,
      stages: bootstrapState.stages,
    });
    expect(check).not.toHaveBeenCalled();
  });

  it("returns 503 when the bounded database probe reports disconnected after failure or timeout", async () => {
    markAllStagesDone();
    markReady();
    const check = vi.spyOn(getApp().databaseReadinessProbe, "check").mockResolvedValue("disconnected");

    const res = await getApp().inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      ready: false,
      db: "disconnected",
      startedAt: bootstrapState.startedAt.toISOString(),
      readyAt: bootstrapState.readyAt?.toISOString(),
      stages: bootstrapState.stages,
    });
    expect(check).toHaveBeenCalledOnce();
  });
});
