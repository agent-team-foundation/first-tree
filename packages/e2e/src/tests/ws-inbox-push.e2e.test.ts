import { randomBytes } from "node:crypto";
import type { InboxDeliverFrame } from "@agent-team-foundation/first-tree-hub-shared";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CurrentRunHandle, readCredentialsOrThrow, readCurrentHandle } from "../framework/current-handle.js";
import { connectWsListener, type WsListener } from "../framework/server-driver/ws.js";

/**
 * WS inbox push e2e — exercises the **Server → Client** half of "Inbox is
 * the Server/Client boundary" (architecture rule in CLAUDE.md): a chat
 * message POST triggers PG NOTIFY → server WS push → `inbox:deliver`
 * frame on a connected listener.
 *
 * What's tested:
 *   1. The full WS handshake: `auth` → `auth:ok`, `client:register` →
 *      `client:registered`, `agent:bind` → `agent:bound`. None of these
 *      have been covered by the existing tests, which all drive the
 *      server through HTTP routes.
 *   2. The fan-out path: server's `sendMessage` → `inbox_entries` write +
 *      PG NOTIFY → instance-level subscriber → per-socket inbox push.
 *
 * Why a fresh test client (not the spawned CLI from globalSetup):
 *   - The spawned CLI is already registered with `creds.clientId`. A
 *     second WS that re-registers with the same `clientId` evicts the
 *     first (`connectionManager.setClientConnection`). We need our own
 *     parallel client so the spawned one stays up for other tests.
 *
 * Direct PG writes here are limited to:
 *   - INSERT INTO clients (id, user_id, organization_id) — same shape
 *     and rationale as the credentials helper's existing client seed.
 *
 * Test agent + chat are created via the public HTTP API.
 */

let handle: CurrentRunHandle;
let listener: WsListener;
let listenerClientId: string;
let testAgentId: string;
let chatId: string;

beforeAll(async () => {
  handle = readCurrentHandle();
  const creds = readCredentialsOrThrow(handle);
  listenerClientId = `client_${randomBytes(4).toString("hex")}`;

  // Pre-seed the listener's clients row (same pattern as credentials.ts).
  // The WS handshake's client:register will CLAIM this row.
  const pg = new PgClient({ connectionString: handle.databaseUrl });
  await pg.connect();
  try {
    await pg.query("INSERT INTO clients (id, user_id, organization_id) VALUES ($1, $2, $3)", [
      listenerClientId,
      creds.userId,
      creds.organizationId,
    ]);
  } finally {
    await pg.end();
  }

  // Create an autonomous agent pinned to the listener client — the agent
  // we'll bind on the WS + the one receiving inbox pushes for the chat we
  // build below. Goes through the public API → server validates clientId
  // + manager-in-org.
  const agentRes = await fetch(`${handle.serverBaseUrl}/api/v1/orgs/${creds.organizationId}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.accessToken}` },
    body: JSON.stringify({
      name: `e2e-ws-${randomBytes(3).toString("hex")}`,
      type: "autonomous_agent",
      displayName: "E2E WS Target",
      clientId: listenerClientId,
    }),
  });
  if (agentRes.status !== 201) {
    throw new Error(`failed to create test agent: ${agentRes.status} ${await agentRes.text()}`);
  }
  testAgentId = ((await agentRes.json()) as { uuid: string }).uuid;

  // Create the chat (human + test agent participants).
  const chatRes = await fetch(`${handle.serverBaseUrl}/api/v1/orgs/${creds.organizationId}/chats`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.accessToken}` },
    body: JSON.stringify({ participantIds: [testAgentId] }),
  });
  if (chatRes.status !== 201) {
    throw new Error(`failed to create chat: ${chatRes.status} ${await chatRes.text()}`);
  }
  chatId = ((await chatRes.json()) as { chatId: string }).chatId;

  listener = await connectWsListener({
    serverBaseUrl: handle.serverBaseUrl,
    accessToken: creds.accessToken,
    clientId: listenerClientId,
    bindAgents: [{ agentId: testAgentId }],
  });
});

afterAll(async () => {
  await listener?.close();
});

describe("ws inbox push — chat-send → PG NOTIFY → inbox:deliver frame", () => {
  it("delivers an inbox:deliver frame to a bound agent within timeout", async () => {
    const creds = readCredentialsOrThrow(handle);
    const text = `hello via WS ${randomBytes(3).toString("hex")}`;

    const sendRes = await fetch(`${handle.serverBaseUrl}/api/v1/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.accessToken}` },
      body: JSON.stringify({ format: "text", content: text }),
    });
    expect(sendRes.status).toBe(201);
    const sent = (await sendRes.json()) as { id: string };

    // Server-side fanout is async — NOTIFY lands on a separate loop tick,
    // subscriber writes the frame, socket pushes. 5s is conservative; on a
    // warm local stack we usually see it under 50ms.
    const frame = await listener.waitFor(
      (f) => f.type === "inbox:deliver" && (f as Partial<InboxDeliverFrame>).message?.id === sent.id,
      5_000,
    );

    const payload = frame as unknown as InboxDeliverFrame;
    expect(payload.chatId).toBe(chatId);
    expect(typeof payload.entryId).toBe("number");
    // `entryId` is the `inbox_entries.id` bigserial — schema allows 0, in
    // practice always ≥ 1.
    expect(payload.entryId).toBeGreaterThan(0);
    expect(payload.inboxId).toBe(`inbox_${testAgentId}`);
    expect(payload.message.id).toBe(sent.id);
    expect(payload.message.format).toBe("text");
    expect(payload.message.content).toBe(text);
    expect(payload.message.senderId).toBe(creds.humanAgentId);
  });

  it("delivers a second inbox:deliver frame for a follow-up message", async () => {
    const creds = readCredentialsOrThrow(handle);
    const text = `second push ${randomBytes(3).toString("hex")}`;

    const sendRes = await fetch(`${handle.serverBaseUrl}/api/v1/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.accessToken}` },
      body: JSON.stringify({ format: "text", content: text }),
    });
    expect(sendRes.status).toBe(201);
    const sent = (await sendRes.json()) as { id: string };

    const frame = await listener.waitFor(
      (f) => f.type === "inbox:deliver" && (f as Partial<InboxDeliverFrame>).message?.id === sent.id,
      5_000,
    );
    const payload = frame as unknown as InboxDeliverFrame;
    expect(payload.message.content).toBe(text);
  });
});
