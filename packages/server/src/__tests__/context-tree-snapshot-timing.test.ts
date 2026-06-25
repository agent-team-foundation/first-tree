import { describe, expect, it } from "vitest";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("context tree snapshot timing", () => {
  const getApp = useTestApp();

  it("emits Server-Timing for org-scoped context tree snapshots", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/orgs/${admin.organizationId}/context-tree/snapshot?window=7d`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["server-timing"]).toEqual(expect.stringContaining("auth;dur="));
    expect(response.headers["server-timing"]).toEqual(expect.stringContaining("snapshot_build;dur="));
    expect(response.headers["server-timing"]).toEqual(expect.stringContaining("schema_parse;dur="));
  });
});
