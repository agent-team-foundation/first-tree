import { describe, expect, it } from "vitest";
import { useTestApp } from "./helpers.js";

describe("GET /bootstrap/config", () => {
  const getApp = useTestApp();

  it("returns the public server command version", async () => {
    const app = getApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/bootstrap/config",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      allowedOrg: null,
      serverCommandVersion: "test.version",
    });
  });
});
