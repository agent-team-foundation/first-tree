import { afterAll, describe, expect, it } from "vitest";
import { createTestAdmin, createTestApp } from "./helpers.js";

describe("Admin System Config API", () => {
  const appPromise = createTestApp();
  afterAll(async () => (await appPromise).close());

  async function authedRequest(app: Awaited<ReturnType<typeof createTestApp>>) {
    const admin = await createTestAdmin(app);
    return (method: string, url: string, payload?: unknown) =>
      app.inject({
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        url,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        ...(payload ? { payload } : {}),
      });
  }

  it("returns default config values", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const res = await req("GET", "/admin/system/config");
    expect(res.statusCode).toBe(200);
    const config = res.json();
    expect(config.inbox_timeout_seconds).toBe(300);
    expect(config.max_retry_count).toBe(3);
    expect(config.polling_interval_seconds).toBe(5);
    expect(config.presence_cleanup_seconds).toBe(60);
  });

  it("updates config values", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const res = await req("PATCH", "/admin/system/config", {
      inbox_timeout_seconds: 600,
      max_retry_count: 5,
    });
    expect(res.statusCode).toBe(200);
    const config = res.json();
    expect(config.inbox_timeout_seconds).toBe(600);
    expect(config.max_retry_count).toBe(5);
    // Defaults should still be present
    expect(config.polling_interval_seconds).toBe(5);
  });

  it("overwrites previously set values", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    await req("PATCH", "/admin/system/config", { inbox_timeout_seconds: 100 });
    const res = await req("PATCH", "/admin/system/config", { inbox_timeout_seconds: 200 });
    expect(res.statusCode).toBe(200);
    expect(res.json().inbox_timeout_seconds).toBe(200);
  });

  it("rejects unauthenticated requests", async () => {
    const app = await appPromise;
    const res = await app.inject({ method: "GET", url: "/admin/system/config" });
    expect(res.statusCode).toBe(401);
  });
});
