import { describe, expect, it } from "vitest";
import { useTestApp } from "./helpers.js";

describe("POST /auth/cache-eviction", () => {
  const getApp = useTestApp();

  it("returns a best-effort cache clear response to a credential-free same-origin request", async () => {
    const res = await getApp().inject({
      method: "POST",
      url: "/api/v1/auth/cache-eviction",
      headers: { "sec-fetch-site": "same-origin", "x-first-tree-cache-eviction": "1" },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers["clear-site-data"]).toBe('"cache"');
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toBe("");
  });

  it.each([
    { name: "missing marker", headers: { "sec-fetch-site": "same-origin" } },
    {
      name: "cross-site",
      headers: { "sec-fetch-site": "cross-site", "x-first-tree-cache-eviction": "1" },
    },
    {
      name: "bearer-bearing",
      headers: {
        "sec-fetch-site": "same-origin",
        "x-first-tree-cache-eviction": "1",
        authorization: "Bearer must-not-be-used",
      },
    },
    {
      name: "cookie-bearing",
      headers: {
        "sec-fetch-site": "same-origin",
        "x-first-tree-cache-eviction": "1",
        cookie: "first_tree_session=must-not-be-used",
      },
    },
    {
      name: "proxy-credential-bearing",
      headers: {
        "sec-fetch-site": "same-origin",
        "x-first-tree-cache-eviction": "1",
        "proxy-authorization": "Basic must-not-be-used",
      },
    },
    {
      name: "contradictory cross-origin",
      headers: {
        "sec-fetch-site": "cross-site",
        "x-first-tree-cache-eviction": "1",
        origin: "http://127.0.0.1:0",
      },
    },
  ])("rejects a $name request without emitting Clear-Site-Data", async ({ headers }) => {
    const res = await getApp().inject({ method: "POST", url: "/api/v1/auth/cache-eviction", headers });

    expect(res.statusCode).toBe(403);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["clear-site-data"]).toBeUndefined();
  });
});
