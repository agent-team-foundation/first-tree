import { describe, expect, it } from "vitest";
import { createTestApp, useTestApp } from "./helpers.js";

describe("GET /bootstrap/config", () => {
  const getApp = useTestApp();

  it("returns the public server command version, release channel, and disabled growth flag by default", async () => {
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
      growthLandingPagesEnabled: false,
      authProviders: { google: false, github: true },
    });
  });
});

describe("GET /bootstrap/server-authority", () => {
  const getApp = useTestApp();

  it("returns the configured token-free authority without caching", async () => {
    const res = await getApp().inject({ method: "GET", url: "/api/v1/bootstrap/server-authority" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ v: 1, authority: "http://127.0.0.1:0/api/v1" });
  });

  it("does not derive authority from request host or forwarded headers", async () => {
    const res = await getApp().inject({
      method: "GET",
      url: "/api/v1/bootstrap/server-authority",
      headers: { host: "s2.example", "x-forwarded-host": "s3.example" },
    });

    expect(res.json().authority).toBe("http://127.0.0.1:0/api/v1");
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

describe("GET /bootstrap/config — growth landing flag", () => {
  const getApp = useTestApp({ channel: "prod", growthLandingPagesEnabled: true });

  it("reports the feature flag independently from release channel", async () => {
    const res = await getApp().inject({ method: "GET", url: "/api/v1/bootstrap/config" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      channel: "prod",
      growthLandingPagesEnabled: true,
    });
  });
});

describe("GET /bootstrap/config — authentication provider availability", () => {
  it("reports a Google-only deployment", async () => {
    const app = await createTestApp({ googleOAuth: true, githubOAuth: false });
    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/bootstrap/config" });
      expect(res.json().authProviders).toEqual({ google: true, github: false });
    } finally {
      await app.close();
    }
  });

  it("reports a GitHub-only deployment", async () => {
    const app = await createTestApp({ githubOAuth: true });
    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/bootstrap/config" });
      expect(res.json().authProviders).toEqual({ google: false, github: true });
    } finally {
      await app.close();
    }
  });
});
