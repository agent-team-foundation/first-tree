import type { CapabilityEntry, RuntimeProvider } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { clients } from "../db/schema/clients.js";
import { createAgent, rebindAgent } from "../services/agent.js";
import { createAdminContext, useTestApp } from "./helpers.js";

/**
 * Coverage for the post-0026 capability gate in `services/agent.ts`:
 *
 *   - `clientCapabilitiesReported` distinguishes "never probed" (allow,
 *     unknown) from "probed but missing this provider" (block).
 *   - `clientSupportsRuntimeProvider` requires `entry.available === true` —
 *     i.e. `state` ∈ {ok, unauthenticated}. `missing` / `error` blocks
 *     unless `force: true`.
 *
 * The gate is invoked from `createAgent` (creation pre-flight) and
 * `rebindAgent` (re-pin). Both paths get one happy / one blocked / one
 * forced case so a regression in either call site fails this suite.
 */

function entry(state: CapabilityEntry["state"]): CapabilityEntry {
  // The `available` field follows `state` — `ok`/`unauthenticated` keep the
  // SDK reachable; `missing`/`error` mark it unusable. Mirrors the probes.
  const available = state === "ok" || state === "unauthenticated";
  return {
    state,
    available,
    authenticated: state === "ok",
    sdkVersion: available ? "1.0.0-test" : null,
    authMethod: state === "ok" ? "api_key" : "none",
    detectedAt: new Date().toISOString(),
  };
}

async function setCapabilities(
  app: { db: import("../db/connection.js").Database },
  clientId: string,
  caps: Partial<Record<RuntimeProvider, CapabilityEntry>>,
): Promise<void> {
  await app.db
    .update(clients)
    .set({ metadata: { capabilities: caps } })
    .where(eq(clients.id, clientId));
}

describe("Agent capability gate (services/agent.ts)", () => {
  const getApp = useTestApp();

  it("allows creation when client has not reported capabilities yet (unknown ⇒ allow)", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    // ctx.clientId is freshly seeded — metadata is null.
    const created = await createAgent(app.db, {
      name: `cap-gate-empty-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    });
    expect(created.runtimeProvider).toBe("claude-code");
  });

  it("allows creation when reported capability state is `ok`", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    await setCapabilities(app, ctx.clientId, { "claude-code": entry("ok") });

    const created = await createAgent(app.db, {
      name: `cap-gate-ok-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    });
    expect(created.runtimeProvider).toBe("claude-code");
  });

  it("allows creation when reported state is `unauthenticated` (available SDK, user fixes login)", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    await setCapabilities(app, ctx.clientId, { codex: entry("unauthenticated") });

    const created = await createAgent(app.db, {
      name: `cap-gate-unauth-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "codex",
    });
    expect(created.runtimeProvider).toBe("codex");
  });

  it("blocks creation when reported state is `missing`", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    // Probe always emits an entry per built-in provider — `missing` here is
    // *reported*, not absent. The pre-fix code accepted this; we now reject.
    await setCapabilities(app, ctx.clientId, {
      "claude-code": entry("ok"),
      codex: entry("missing"),
    });

    await expect(
      createAgent(app.db, {
        name: `cap-gate-missing-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        managerId: ctx.memberId,
        clientId: ctx.clientId,
        runtimeProvider: "codex",
      }),
    ).rejects.toThrow(/does not have runtime provider "codex" available/i);
  });

  it("blocks creation when reported state is `error`", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    await setCapabilities(app, ctx.clientId, { "claude-code": entry("error") });

    await expect(
      createAgent(app.db, {
        name: `cap-gate-error-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        managerId: ctx.memberId,
        clientId: ctx.clientId,
        runtimeProvider: "claude-code",
      }),
    ).rejects.toThrow(/does not have runtime provider "claude-code" available/i);
  });

  it("`force: true` bypasses the gate even when the SDK is reported missing", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    await setCapabilities(app, ctx.clientId, { codex: entry("missing") });

    const created = await createAgent(
      app.db,
      {
        name: `cap-gate-force-${crypto.randomUUID().slice(0, 6)}`,
        type: "agent",
        managerId: ctx.memberId,
        clientId: ctx.clientId,
        runtimeProvider: "codex",
      },
      { force: true },
    );
    expect(created.runtimeProvider).toBe("codex");
  });

  it("skips the gate for human agents (no client pinning)", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    // Even with capabilities saying nothing is available, a human agent has
    // no clientId — the gate must short-circuit before any client lookup.
    await setCapabilities(app, ctx.clientId, {
      "claude-code": entry("missing"),
      codex: entry("missing"),
    });

    const human = await createAgent(app.db, {
      name: `cap-gate-human-${crypto.randomUUID().slice(0, 6)}`,
      type: "human",
      managerId: ctx.memberId,
    });
    expect(human.clientId).toBeNull();
  });

  it("rebindAgent enforces the gate against the new client", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    await setCapabilities(app, ctx.clientId, { "claude-code": entry("ok") });

    const agent = await createAgent(app.db, {
      name: `cap-gate-rebind-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    });

    // Now mark the same client as "missing codex" and try to rebind to codex.
    await setCapabilities(app, ctx.clientId, {
      "claude-code": entry("ok"),
      codex: entry("missing"),
    });

    await expect(
      rebindAgent(app.db, agent.uuid, {
        clientId: ctx.clientId,
        runtimeProvider: "codex",
      }),
    ).rejects.toThrow(/does not have runtime provider "codex" available/i);

    // After upgrading the report to `unauthenticated` (SDK installed),
    // the same rebind succeeds.
    await setCapabilities(app, ctx.clientId, {
      "claude-code": entry("ok"),
      codex: entry("unauthenticated"),
    });
    const rebound = await rebindAgent(app.db, agent.uuid, {
      clientId: ctx.clientId,
      runtimeProvider: "codex",
    });
    expect(rebound.runtimeProvider).toBe("codex");
  });
});
