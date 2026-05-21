import { randomBytes } from "node:crypto";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CurrentRunHandle, readCredentialsOrThrow, readCurrentHandle } from "../framework/current-handle.js";
import { authedFetch, authedJson } from "../framework/server-driver/http.js";
import { connectWsListener, type WsListener } from "../framework/server-driver/ws.js";

/**
 * Server → Client session-control e2e.
 *
 * Wire contract under test (handlers in `packages/server/src/api/sessions.ts`
 * + WS push via `connectionManager.sendToAgent`):
 *
 *   POST /api/v1/agents/:uuid/sessions/:chatId/suspend
 *     → flips `agent_chat_sessions.state` active → suspended
 *     → server pushes `{type: "session:suspend", chatId}` to the bound client.
 *
 *   POST /api/v1/agents/:uuid/sessions/:chatId/terminate
 *     → flips state to "evicted" + clears session events
 *     → server pushes `{type: "session:terminate", chatId}`.
 *
 * There is intentionally **no** resume HTTP route — sessions resume
 * implicitly on next inbox delivery. That asymmetry is what makes the
 * suspend frame matter on its own: without it the long-running client
 * keeps a stale session attached after the admin acted.
 *
 * Session creation goes through the WS `session:state` frame (calls
 * `activityService.upsertSessionState`) rather than direct PG, so we
 * exercise the same code path the real client uses to first register
 * a session.
 *
 * Requires `E2E_WITH_CLIENT=1`.
 */

let handle: CurrentRunHandle;
let listenerClientId: string;
let agentId: string;
let chatId: string;
let listener: WsListener;
let pg: PgClient;

async function readSessionState(): Promise<string | null> {
  const res = await pg.query<{ state: string | null }>(
    "SELECT state FROM agent_chat_sessions WHERE agent_id = $1 AND chat_id = $2 LIMIT 1",
    [agentId, chatId],
  );
  return res.rows[0]?.state ?? null;
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
        name: `e2e-sess-${randomBytes(3).toString("hex")}`,
        type: "autonomous_agent",
        displayName: "E2E Session Control Target",
        clientId: listenerClientId,
      },
      201,
    )
  ).uuid;

  chatId = (
    await authedJson<{ chatId: string }>(
      handle.serverBaseUrl,
      creds.accessToken,
      "POST",
      `/api/v1/orgs/${encodeURIComponent(creds.organizationId)}/chats`,
      { participantIds: [agentId] },
      201,
    )
  ).chatId;

  listener = await connectWsListener({
    serverBaseUrl: handle.serverBaseUrl,
    accessToken: creds.accessToken,
    clientId: listenerClientId,
    bindAgents: [{ agentId }],
  });

  // Drive a real session into existence via the same `session:state` frame
  // the production client sends on session-start. The server validates with
  // `sessionStateMessageSchema` (chatId + state ∈ {active, suspended, errored})
  // and writes through `activityService.upsertSessionState`.
  listener.send({ type: "session:state", agentId, chatId, state: "active" });

  // Poll PG until the row materialises — upsertSessionState is async and
  // the WS handler intentionally fires it without sending an ack frame.
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const state = await readSessionState();
    if (state === "active") break;
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  const initial = await readSessionState();
  if (initial !== "active") {
    throw new Error(
      `session:state precondition failed — agent_chat_sessions.state=${String(initial)} (expected active)`,
    );
  }
});

afterAll(async () => {
  await listener?.close();
  await pg.end().catch(() => undefined);
});

describe("server → client session control", () => {
  it("POST /agents/:uuid/sessions/:chatId/suspend transitions state and pushes session:suspend", async () => {
    const creds = readCredentialsOrThrow(handle);
    const res = await authedFetch(
      handle.serverBaseUrl,
      creds.accessToken,
      "POST",
      `/api/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(chatId)}/suspend`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; transitioned: boolean };
    expect(body.state).toBe("suspended");
    expect(body.transitioned).toBe(true);

    expect(await readSessionState()).toBe("suspended");

    const frame = await listener.waitFor((f) => f.type === "session:suspend" && f.chatId === chatId, 5_000);
    expect(frame.chatId).toBe(chatId);
  });

  it("POST /agents/:uuid/sessions/:chatId/terminate evicts the session and pushes session:terminate", async () => {
    const creds = readCredentialsOrThrow(handle);
    const res = await authedFetch(
      handle.serverBaseUrl,
      creds.accessToken,
      "POST",
      `/api/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(chatId)}/terminate`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; transitioned: boolean };
    // archiveSession reports the post-state ("evicted") in the response,
    // while wire-level transitions only fire `session:terminate` for
    // observers — see api/sessions.ts.
    expect(body.state).toBe("evicted");
    expect(body.transitioned).toBe(true);

    expect(await readSessionState()).toBe("evicted");

    const frame = await listener.waitFor((f) => f.type === "session:terminate" && f.chatId === chatId, 5_000);
    expect(frame.chatId).toBe(chatId);
  });
});
