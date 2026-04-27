import { describe, expect, it } from "vitest";
import { useTestApp } from "./helpers.js";

describe("GET /api/v1/health", () => {
  const getApp = useTestApp();

  it("returns ok with db connected", async () => {
    const app = getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    // `commandVersion` is part of the response since the SaaS-onboarding
    // CLI-drift check (`first-tree-hub client connect`) reads it to warn
    // the user when the local CLI is older than the server. See
    // packages/command/src/commands/connect.ts::warnIfCliBehind.
    expect(res.json()).toMatchObject({ status: "ok", db: "connected" });
    expect((res.json() as { commandVersion: string }).commandVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});
