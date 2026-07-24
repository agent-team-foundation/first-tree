import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapState, markReady, markStage } from "../bootstrap-state.js";
import { createTestApp } from "./helpers.js";

function resetBootstrapState() {
  for (const key of Object.keys(bootstrapState.stages)) {
    delete bootstrapState.stages[key];
  }
  bootstrapState.readyAt = null;
}

function markBootstrapReady() {
  markStage("initTelemetry", { status: "done", durationMs: 1 });
  markStage("runMigrations", { status: "done", durationMs: 1 });
  markStage("buildApp", { status: "done", durationMs: 1 });
  markStage("appListen", { status: "done", durationMs: 1 });
  markReady();
}

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!resolvePromise) throw new Error("deferred promise was not initialized");
      resolvePromise(value);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetBootstrapState();
});

describe("health and readiness integration", () => {
  it("serves 100 concurrent liveness requests without a database or readiness probe call", async () => {
    const app = await createTestApp();
    try {
      const execute = vi.spyOn(app.db, "execute");
      const check = vi.spyOn(app.databaseReadinessProbe, "check");

      const responses = await Promise.all(
        Array.from({ length: 100 }, () => app.inject({ method: "GET", url: "/healthz" })),
      );

      for (const response of responses) {
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: "ok" });
      }
      expect(check).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("coalesces 100 mixed readiness and diagnostic requests into one database query", async () => {
    const app = await createTestApp();
    const query = deferred<unknown>();
    try {
      markBootstrapReady();
      const execute = vi.spyOn(app.db, "execute").mockImplementation(() => query.promise as never);
      const requests = Array.from({ length: 100 }, (_, index) => {
        const url = index % 2 === 0 ? "/readyz" : "/api/v1/health";
        return { url, response: app.inject({ method: "GET", url }) };
      });

      await vi.waitFor(() => {
        expect(execute).toHaveBeenCalledOnce();
      });
      query.resolve(undefined);
      const responses = await Promise.all(requests.map(({ response }) => response));

      expect(execute).toHaveBeenCalledOnce();
      for (const [index, response] of responses.entries()) {
        if (index % 2 === 0) {
          expect(response.statusCode).toBe(200);
          expect(response.json()).toEqual({
            ready: true,
            db: "connected",
            startedAt: bootstrapState.startedAt.toISOString(),
            readyAt: bootstrapState.readyAt?.toISOString(),
            stages: bootstrapState.stages,
          });
        } else {
          expect(response.statusCode).toBe(200);
          expect(response.json()).toEqual({ status: "ok", db: "connected" });
        }
      }
    } finally {
      query.resolve(undefined);
      await app.close();
    }
  });

  it("keeps readiness probe state isolated between independently built apps", async () => {
    const firstApp = await createTestApp();
    try {
      const secondApp = await createTestApp();
      try {
        markBootstrapReady();
        const firstExecute = vi.spyOn(firstApp.db, "execute");
        const secondExecute = vi.spyOn(secondApp.db, "execute");

        const [firstResponse, secondResponse] = await Promise.all([
          firstApp.inject({ method: "GET", url: "/readyz" }),
          secondApp.inject({ method: "GET", url: "/readyz" }),
        ]);

        const expectedBody = {
          ready: true,
          db: "connected",
          startedAt: bootstrapState.startedAt.toISOString(),
          readyAt: bootstrapState.readyAt?.toISOString(),
          stages: bootstrapState.stages,
        };
        expect(firstResponse.statusCode).toBe(200);
        expect(firstResponse.json()).toEqual(expectedBody);
        expect(secondResponse.statusCode).toBe(200);
        expect(secondResponse.json()).toEqual(expectedBody);
        expect(firstExecute).toHaveBeenCalledOnce();
        expect(secondExecute).toHaveBeenCalledOnce();
      } finally {
        await secondApp.close();
      }
    } finally {
      await firstApp.close();
    }
  });

  it("exempts liveness and readiness from a low global cap while keeping diagnostics limited", async () => {
    const app = await createTestApp({ rateLimit: { max: 1 } });
    try {
      markBootstrapReady();
      vi.spyOn(app.databaseReadinessProbe, "check").mockResolvedValue("connected");

      for (let i = 0; i < 3; i++) {
        const liveness = await app.inject({ method: "GET", url: "/healthz" });
        expect(liveness.statusCode).toBe(200);
        expect(liveness.json()).toEqual({ status: "ok" });

        const readiness = await app.inject({ method: "GET", url: "/readyz" });
        expect(readiness.statusCode).toBe(200);
        expect(readiness.json()).toEqual({
          ready: true,
          db: "connected",
          startedAt: bootstrapState.startedAt.toISOString(),
          readyAt: bootstrapState.readyAt?.toISOString(),
          stages: bootstrapState.stages,
        });
      }

      const firstDiagnostic = await app.inject({ method: "GET", url: "/api/v1/health" });
      expect(firstDiagnostic.statusCode).toBe(200);
      expect(firstDiagnostic.json()).toEqual({ status: "ok", db: "connected" });

      const rateLimitedDiagnostic = await app.inject({ method: "GET", url: "/api/v1/health" });
      expect(rateLimitedDiagnostic.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});
