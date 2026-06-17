import { describe, expect, it } from "vitest";
import { useTestApp } from "./helpers.js";

describe("GET /bootstrap/config", () => {
  const getApp = useTestApp();

  it("returns the public server command version and release channel", async () => {
    const app = getApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/bootstrap/config",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      allowedOrg: null,
      serverCommandVersion: "test.version",
      // Surfaced so the web can gate channel-scoped UI (e.g. the staging-only
      // "hide agent final text" toggle). Test app defaults to the dev channel.
      channel: "dev",
    });
  });
});

describe("GET /bootstrap/config — non-dev channel", () => {
  const getApp = useTestApp({ channel: "staging" });

  it("reports the server's configured channel verbatim", async () => {
    const res = await getApp().inject({ method: "GET", url: "/api/v1/bootstrap/config" });

    expect(res.statusCode).toBe(200);
    expect(res.json().channel).toBe("staging");
  });
});
