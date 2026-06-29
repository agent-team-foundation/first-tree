import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { clients } from "../db/schema/clients.js";
import { createAdminContext, useTestApp } from "./helpers.js";

/**
 * `PATCH /api/v1/clients/:clientId/capabilities` is the upload entry point
 * for the per-machine runtime probe results. It must:
 *   - persist the snapshot under `clients.metadata.capabilities` while
 *     preserving sibling `metadata.*` keys (Option C),
 *   - reject malformed payloads at the schema layer (400),
 *   - 404 when the caller does not own the client (assertClientOwner).
 */
describe("PATCH /clients/:clientId/capabilities", () => {
  const getApp = useTestApp();

  function makeEntry(state: "ok" | "missing" = "ok") {
    return {
      state,
      available: state === "ok",
      sdkVersion: state === "ok" ? "1.2.3" : null,
      detectedAt: new Date().toISOString(),
    };
  }

  it("persists the capabilities snapshot under clients.metadata.capabilities", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);

    // Pre-seed an unrelated metadata key — we expect it to survive the
    // capabilities write (the service deep-merges, not overwrites).
    await app.db
      .update(clients)
      .set({ metadata: { siblingKey: "preserve-me" } })
      .where(eq(clients.id, ctx.clientId));

    const payload = {
      capabilities: {
        "claude-code": makeEntry("ok"),
        codex: makeEntry("missing"),
      },
    };

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/clients/${ctx.clientId}/capabilities`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload,
    });
    expect(res.statusCode).toBe(204);

    const [row] = await app.db
      .select({ metadata: clients.metadata })
      .from(clients)
      .where(eq(clients.id, ctx.clientId))
      .limit(1);
    const meta = (row?.metadata ?? {}) as Record<string, unknown>;
    expect(meta.siblingKey).toBe("preserve-me");
    const caps = meta.capabilities as Record<string, { state: string; sdkVersion: string | null }>;
    expect(caps["claude-code"]?.state).toBe("ok");
    expect(caps["claude-code"]?.sdkVersion).toBe("1.2.3");
    expect(caps.codex?.state).toBe("missing");
    expect(caps.codex?.sdkVersion).toBeNull();
  });

  it("accepts repeated identical snapshots as a no-op while preserving sibling metadata", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    const capabilities = {
      "claude-code": makeEntry("ok"),
      codex: makeEntry("missing"),
    };

    await app.db
      .update(clients)
      .set({ metadata: { siblingKey: "preserve-me", capabilities } })
      .where(eq(clients.id, ctx.clientId));

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/clients/${ctx.clientId}/capabilities`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { capabilities },
    });
    expect(res.statusCode).toBe(204);

    const [row] = await app.db
      .select({ metadata: clients.metadata })
      .from(clients)
      .where(eq(clients.id, ctx.clientId))
      .limit(1);
    expect(row?.metadata).toEqual({ siblingKey: "preserve-me", capabilities });
  });

  it("rejects an invalid capability state with 400", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/clients/${ctx.clientId}/capabilities`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        capabilities: {
          "claude-code": {
            state: "pending", // <- not in the schema enum
            available: true,
            authenticated: false,
            authMethod: "none",
            detectedAt: new Date().toISOString(),
          },
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s on an unknown clientId (assertClientOwner rejects before service call)", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/clients/cli-does-not-exist/capabilities`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { capabilities: { "claude-code": makeEntry("ok") } },
    });
    expect(res.statusCode).toBe(404);
  });
});
