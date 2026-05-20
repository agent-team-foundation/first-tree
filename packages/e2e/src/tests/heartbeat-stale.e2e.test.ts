import { randomBytes } from "node:crypto";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CurrentRunHandle, readCredentialsOrThrow, readCurrentHandle } from "../framework/current-handle.js";
import { authedJson } from "../framework/server-driver/http.js";
import { connectWsListener, type WsListener } from "../framework/server-driver/ws.js";

/**
 * Heartbeat + stale-detection + runtime_state e2e — three closely-related
 * presence surfaces, all exercised through `agent_presence`:
 *
 *   1. Client → Server `{type:"heartbeat"}` frame ↔ server `heartbeat:ack`
 *      reply. The handler also `touchAgent`s every bound agent's
 *      `last_seen_at` (ws-client.ts handler, presenceService.touchAgent).
 *
 *   2. Client → Server `{type:"runtime:state", agentId, runtimeState}` frame
 *      flips `agent_presence.runtime_state` server-side (handler calls
 *      `presenceService.setRuntimeState`). Workspace badge state lives on
 *      this column.
 *
 *   3. Server-side stale-detection loop in `services/background-tasks.ts`
 *      (30s tick) runs `presenceService.markStaleAgents(db, staleSeconds)`
 *      and flips `status` `online` → `offline` for any row whose
 *      `last_seen_at` is older than `staleSeconds` (default 60).
 *
 * Fast-path trick for (3): rather than wait the full 60s of real idleness,
 * we backdate `last_seen_at` to `NOW() - 65s` via PG and let the next 30s
 * background tick observe the staleness. The test budget caps at 45s so
 * the worst-case wait (one full interval + buffer) still fits.
 *
 * Requires `E2E_WITH_CLIENT=1`.
 */

const STALE_TICK_INTERVAL_MS = 30_000;
const STALE_BACKDATE_SECONDS = 65;
const STALE_TEST_BUDGET_MS = STALE_TICK_INTERVAL_MS + 12_000;

let handle: CurrentRunHandle;
let listenerClientId: string;
let agentId: string;
let listener: WsListener;
let pg: PgClient;

async function readPresence(): Promise<{ status: string | null; runtime_state: string | null } | null> {
  const res = await pg.query<{ status: string | null; runtime_state: string | null }>(
    "SELECT status, runtime_state FROM agent_presence WHERE agent_id = $1 LIMIT 1",
    [agentId],
  );
  return res.rows[0] ?? null;
}

beforeAll(async () => {
  handle = readCurrentHandle();
  const creds = readCredentialsOrThrow(handle);
  listenerClientId = `client_${randomBytes(4).toString("hex")}`;

  pg = new PgClient({ connectionString: handle.databaseUrl });
  await pg.connect();
  await pg.query("INSERT INTO clients (id, user_id, organization_id) VALUES ($1, $2, $3)", [
    listenerClientId,
    creds.userId,
    creds.organizationId,
  ]);

  agentId = (
    await authedJson<{ uuid: string }>(
      handle.serverBaseUrl,
      creds.accessToken,
      "POST",
      `/api/v1/orgs/${encodeURIComponent(creds.organizationId)}/agents`,
      {
        name: `e2e-hb-${randomBytes(3).toString("hex")}`,
        type: "autonomous_agent",
        displayName: "E2E Heartbeat Target",
        clientId: listenerClientId,
      },
      201,
    )
  ).uuid;

  // `agent:bind` populates the `agent_presence` row with status='online' +
  // runtime_state='idle'. That's the precondition the stale loop reads
  // — without an online row there's nothing for `markStaleAgents` to
  // flip.
  listener = await connectWsListener({
    serverBaseUrl: handle.serverBaseUrl,
    accessToken: creds.accessToken,
    clientId: listenerClientId,
    bindAgents: [{ agentId }],
  });
});

afterAll(async () => {
  await listener?.close();
  await pg.end().catch(() => undefined);
});

describe("agent_presence — heartbeat, runtime_state, stale-detection", () => {
  it("heartbeat frame round-trips heartbeat:ack and keeps the agent online", async () => {
    listener.send({ type: "heartbeat" });
    const ack = await listener.waitFor((f) => f.type === "heartbeat:ack", 3_000);
    expect(ack.type).toBe("heartbeat:ack");
    // touchAgent ran for the bound agent; presence row stays online.
    expect((await readPresence())?.status).toBe("online");
  });

  it("runtime:state frame flips agent_presence.runtime_state server-side", async () => {
    // Walk through the canonical client-reported state transitions. The
    // server has no per-step ack; poll PG with a short deadline instead.
    const states = ["working", "blocked", "idle"] as const;
    for (const state of states) {
      listener.send({ type: "runtime:state", agentId, runtimeState: state });
      const deadline = Date.now() + 3_000;
      let observed: string | null = null;
      while (Date.now() < deadline) {
        observed = (await readPresence())?.runtime_state ?? null;
        if (observed === state) break;
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      expect(observed).toBe(state);
    }
  });

  it(
    "stale-detection loop flips status online → offline when last_seen_at predates the cleanup window",
    async () => {
      // Confirm we're starting from online — earlier tests in this file
      // left the agent bound, runtime_state=idle, status=online.
      expect((await readPresence())?.status).toBe("online");

      // Backdate beyond the default 60s cleanup window so the next
      // background tick has a row to mark stale. Bypassing the natural
      // 60s idle wait is what makes this test viable inside the 60s
      // vitest default.
      const updated = await pg.query(
        "UPDATE agent_presence SET last_seen_at = NOW() - make_interval(secs => $1) WHERE agent_id = $2",
        [STALE_BACKDATE_SECONDS, agentId],
      );
      expect(updated.rowCount).toBe(1);

      const deadline = Date.now() + STALE_TEST_BUDGET_MS;
      let observed: string | null = (await readPresence())?.status ?? null;
      while (Date.now() < deadline && observed !== "offline") {
        await new Promise<void>((r) => setTimeout(r, 500));
        observed = (await readPresence())?.status ?? null;
      }
      expect(observed).toBe("offline");
    },
    STALE_TEST_BUDGET_MS + 5_000,
  );
});
