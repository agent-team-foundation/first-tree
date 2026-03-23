import { afterAll, describe, expect, it } from "vitest";
import { createTestApp } from "./helpers.js";

describe("GET /api/v1/health", () => {
  const appPromise = createTestApp();
  afterAll(async () => (await appPromise).close());

  it("returns ok with db connected", async () => {
    const app = await appPromise;
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", db: "connected" });
  });
});
