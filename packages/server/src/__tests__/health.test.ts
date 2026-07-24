import { afterEach, describe, expect, it, vi } from "vitest";
import { useTestApp } from "./helpers.js";

describe("GET /api/v1/health", () => {
  const getApp = useTestApp();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok with db connected", async () => {
    const app = getApp();
    const check = vi.spyOn(app.databaseReadinessProbe, "check").mockResolvedValue("connected");
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", db: "connected" });
    expect(check).toHaveBeenCalledOnce();
  });

  it("preserves the HTTP 200 degraded contract when the database probe is disconnected", async () => {
    const app = getApp();
    const check = vi.spyOn(app.databaseReadinessProbe, "check").mockResolvedValue("disconnected");

    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "degraded", db: "disconnected" });
    expect(check).toHaveBeenCalledOnce();
  });
});
