import { describe, expect, it } from "vitest";
import { useTestApp } from "./helpers.js";

describe("GET /api/v1/health", () => {
  const getApp = useTestApp();

  it("returns ok with db connected", async () => {
    const app = getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", db: "connected" });
  });
});
