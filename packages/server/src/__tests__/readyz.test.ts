import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    resetState();
  });

  it("returns 503 with stage detail when stages have not been marked done", async () => {
    const res = await getApp().inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.readyAt).toBeNull();
    expect(body.stages).toEqual({});
  });

  it("returns 200 when all stages done and readyAt is set", async () => {
    markAllStagesDone();
    markReady();

    const res = await getApp().inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(true);
    expect(body.readyAt).toBeTruthy();
    expect(body.stages.appListen?.status).toBe("done");
    expect(body.db.ok).toBe(true);
  });

  it("returns 503 with db detail when the database probe reports not ok", async () => {
    markAllStagesDone();
    markReady();

    // The test app runs against a live DB, so the only stable way to exercise
    // the gate is stubbing the decorated checker.
    const app = getApp();
    const originalCheck = app.dbHealth.check;
    app.dbHealth.check = async () => ({ ok: false, checkedAt: new Date().toISOString() });
    try {
      const res = await app.inject({ method: "GET", url: "/readyz" });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.ready).toBe(false);
      expect(body.db.ok).toBe(false);
      expect(body.stages.appListen?.status).toBe("done");
    } finally {
      app.dbHealth.check = originalCheck;
    }
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
});
