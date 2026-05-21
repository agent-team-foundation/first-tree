import { randomBytes } from "node:crypto";
import type { InboxDeliverFrame } from "@agent-team-foundation/first-tree-hub-shared";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CurrentRunHandle, readCredentialsOrThrow, readCurrentHandle } from "../framework/current-handle.js";
import { authedJson } from "../framework/server-driver/http.js";
import { connectWsListener, type WsListener } from "../framework/server-driver/ws.js";

/**
 * Group-chat fan-out e2e — proves that a single chat-send into a
 * multi-participant chat lands one `inbox:deliver` frame per non-sender
 * agent, on **each** agent's own WS connection.
 *
 * Why this matters: `messaging.e2e.test.ts` only covers 1:1 routing and
 * `ws-inbox-push.e2e.test.ts` only checks delivery to a single bound
 * agent. The fan-out path (`services/message.ts` — one row per
 * non-sender into `inbox_entries`, NOTIFY per inbox, server's
 * per-socket push handler) has no e2e coverage today, and group chat is
 * the default mode in the Workspace UI. A regression here is silently
 * user-visible: half the participants never see the message.
 *
 * Setup mirrors `ws-inbox-push`: pre-seed two extra `clients` rows
 * (one per listener), create two autonomous agents via the public API
 * pinned to those clients, build a chat with both as participants,
 * then open one WS listener per agent.
 *
 * Requires `E2E_WITH_CLIENT=1` so credentials are provisioned.
 */

let handle: CurrentRunHandle;
let chatId: string;
let agentAId: string;
let agentBId: string;
let agentAName: string;
let agentBName: string;
let listenerA: WsListener;
let listenerB: WsListener;

beforeAll(async () => {
  handle = readCurrentHandle();
  const creds = readCredentialsOrThrow(handle);

  const clientAId = `client_${randomBytes(4).toString("hex")}`;
  const clientBId = `client_${randomBytes(4).toString("hex")}`;

  // Two extra `clients` rows so each listener owns its own connection
  // — re-using one clientId across two WS would evict the first via
  // `connectionManager.setClientConnection`. Same pattern as
  // `ws-inbox-push.e2e.test.ts`.
  const pg = new PgClient({ connectionString: handle.databaseUrl });
  await pg.connect();
  try {
    for (const id of [clientAId, clientBId]) {
      await pg.query("INSERT INTO clients (id, user_id, organization_id) VALUES ($1, $2, $3)", [
        id,
        creds.userId,
        creds.organizationId,
      ]);
    }
  } finally {
    await pg.end();
  }

  const createAgent = async (clientId: string, label: string): Promise<{ uuid: string; name: string }> => {
    const name = `e2e-fanout-${label}-${randomBytes(3).toString("hex")}`;
    const body = await authedJson<{ uuid: string }>(
      handle.serverBaseUrl,
      creds.accessToken,
      "POST",
      `/api/v1/orgs/${encodeURIComponent(creds.organizationId)}/agents`,
      {
        name,
        type: "autonomous_agent",
        displayName: `E2E Fanout ${label.toUpperCase()}`,
        clientId,
      },
      201,
    );
    return { uuid: body.uuid, name };
  };

  const a = await createAgent(clientAId, "a");
  const b = await createAgent(clientBId, "b");
  agentAId = a.uuid;
  agentBId = b.uuid;
  agentAName = a.name;
  agentBName = b.name;

  const chat = await authedJson<{ chatId: string }>(
    handle.serverBaseUrl,
    creds.accessToken,
    "POST",
    `/api/v1/orgs/${encodeURIComponent(creds.organizationId)}/chats`,
    { participantIds: [agentAId, agentBId] },
    201,
  );
  chatId = chat.chatId;

  listenerA = await connectWsListener({
    serverBaseUrl: handle.serverBaseUrl,
    accessToken: creds.accessToken,
    clientId: clientAId,
    bindAgents: [{ agentId: agentAId }],
  });
  listenerB = await connectWsListener({
    serverBaseUrl: handle.serverBaseUrl,
    accessToken: creds.accessToken,
    clientId: clientBId,
    bindAgents: [{ agentId: agentBId }],
  });
});

afterAll(async () => {
  await listenerA?.close();
  await listenerB?.close();
});

describe("group chat fan-out — one chat-send delivers to every non-sender", () => {
  it("delivers an inbox:deliver frame to each bound agent in the chat", async () => {
    const creds = readCredentialsOrThrow(handle);
    // Group chats (3+ participants) require an explicit @mention per
    // `services/message.ts:enforceGroupMention`. Naming both agents
    // ensures both are in the recipient set with `notify=true`.
    const text = `@${agentAName} @${agentBName} fanout ${randomBytes(3).toString("hex")}`;

    const sent = await authedJson<{ id: string }>(
      handle.serverBaseUrl,
      creds.accessToken,
      "POST",
      `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
      { format: "text", content: text },
      201,
    );

    // Both listeners must observe the same message.id, each on its own
    // socket. Wait independently; failure on either side proves a real
    // fan-out gap (one inbox written but not the other / NOTIFY delivered
    // to one subscription only).
    const [frameA, frameB] = await Promise.all([
      listenerA.waitFor(
        (f) => f.type === "inbox:deliver" && (f as Partial<InboxDeliverFrame>).message?.id === sent.id,
        5_000,
      ),
      listenerB.waitFor(
        (f) => f.type === "inbox:deliver" && (f as Partial<InboxDeliverFrame>).message?.id === sent.id,
        5_000,
      ),
    ]);

    const payloadA = frameA as unknown as InboxDeliverFrame;
    const payloadB = frameB as unknown as InboxDeliverFrame;

    expect(payloadA.chatId).toBe(chatId);
    expect(payloadB.chatId).toBe(chatId);
    expect(payloadA.inboxId).toBe(`inbox_${agentAId}`);
    expect(payloadB.inboxId).toBe(`inbox_${agentBId}`);
    // Distinct inbox_entries rows per participant — the fan-out invariant.
    expect(payloadA.entryId).not.toBe(payloadB.entryId);
    expect(payloadA.message.content).toBe(text);
    expect(payloadB.message.content).toBe(text);
    expect(payloadA.message.senderId).toBe(creds.humanAgentId);
    expect(payloadB.message.senderId).toBe(creds.humanAgentId);
  });

  it("writes one inbox_entries row per non-sender participant", async () => {
    const creds = readCredentialsOrThrow(handle);
    const text = `@${agentAName} @${agentBName} fanout-pg ${randomBytes(3).toString("hex")}`;

    const sent = await authedJson<{ id: string }>(
      handle.serverBaseUrl,
      creds.accessToken,
      "POST",
      `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
      { format: "text", content: text },
      201,
    );

    // The frame deliveries above are the user-visible contract; this PG
    // check pins the storage contract that drives them so a regression
    // upstream of NOTIFY (e.g. the row-per-recipient INSERT collapsing
    // to one row) doesn't slip past behind retries.
    const pg = new PgClient({ connectionString: handle.databaseUrl });
    await pg.connect();
    try {
      const rows = await pg.query<{ inbox_id: string }>(
        "SELECT inbox_id FROM inbox_entries WHERE message_id = $1 ORDER BY inbox_id",
        [sent.id],
      );
      const inboxIds = rows.rows.map((r) => r.inbox_id).sort();
      expect(inboxIds).toEqual([`inbox_${agentAId}`, `inbox_${agentBId}`].sort());
    } finally {
      await pg.end();
    }
  });
});
