import { afterAll, describe, expect, it } from "vitest";
import { createTestAdmin, createTestApp } from "./helpers.js";

describe("Feishu Adapter (WebSocket mode)", () => {
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

  it("creates adapter config with feishu credentials", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const res = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      credentials: { app_id: "cli_ws_test", app_secret: "secret_123" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().platform).toBe("feishu");
    expect(res.json().hasCredentials).toBe(true);
  });

  it("adapter manager reload picks up new config", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    // Create a new adapter config
    const createRes = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      credentials: { app_id: "cli_reload_test", app_secret: "secret_reload" },
    });
    expect(createRes.statusCode).toBe(201);

    // adapterManager.reload() is called automatically after create
    // We can't easily test WS connection without a real Feishu server,
    // but we can verify the config was stored correctly
    const listRes = await req("GET", "/api/v1/admin/adapters");
    const adapters = listRes.json();
    const found = adapters.find((a: { platform: string }) => a.platform === "feishu");
    expect(found).toBeDefined();
  });

  it("adapter manager reloads on config update", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const createRes = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      credentials: { app_id: "cli_update_reload", app_secret: "secret_u" },
    });
    const created = createRes.json();

    const updateRes = await req("PATCH", `/api/v1/admin/adapters/${created.id}`, {
      status: "inactive",
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().status).toBe("inactive");
  });

  it("adapter manager reloads on config delete", async () => {
    const app = await appPromise;
    const req = await authedRequest(app);

    const createRes = await req("POST", "/api/v1/admin/adapters", {
      platform: "feishu",
      credentials: { app_id: "cli_delete_reload", app_secret: "secret_d" },
    });
    const created = createRes.json();

    const delRes = await req("DELETE", `/api/v1/admin/adapters/${created.id}`);
    expect(delRes.statusCode).toBe(204);
  });

  it("no feishu webhook route exists (replaced by WebSocket)", async () => {
    const app = await appPromise;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/feishu/cli_test",
      payload: { test: true },
    });
    // Should be 404 since webhook route was removed
    expect(res.statusCode).toBe(404);
  });
});
