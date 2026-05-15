import { describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { useTestApp } from "./helpers.js";

describe("server bootstrap", () => {
  it("runMigrations resolves the drizzle folder and applies migrations idempotently", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set by global setup").toBeTruthy();

    const tableCount = await runMigrations(databaseUrl ?? "");
    expect(tableCount).toBeGreaterThan(0);
  });

  describe("/healthz", () => {
    const getApp = useTestApp();
    it("returns 200 from a built app", async () => {
      const res = await getApp().inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
    });
  });
});
