import { randomBytes } from "node:crypto";
import type { InboxDeliverFrame } from "@first-tree/shared";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CurrentRunHandle, readCredentialsOrThrow, readCurrentHandle } from "../framework/current-handle.js";
import { authedJson } from "../framework/server-driver/http.js";
import { connectWsListener, type WsListener } from "../framework/server-driver/ws.js";

/**
 * Inbox ack + reconnect-continuity e2e.
 *
 * What it covers:
 *
 *   1. `inbox:ack` actually moves an entry off the in-flight set on the
 *      server — a reconnected socket on the same clientId does NOT see the
 *      acked entry again.
 *   2. After a clean close + reconnect, new messages still push through to
 *      the new socket (no client-id-level "you've already had your turn"
 *      cliff-edge bug).
 *
 * Redelivery of UN-acked entries on reconnect is covered by
 * `inflight-message-recovery.e2e.test.ts` — the server resets every
 * `delivered` row back to `pending` at every `agent:bind`, so a brand-new
 * socket picks the unacked entry up immediately (no 300s reaper).
 *
 * Requires `E2E_WITH_CLIENT=1`.
 */

let handle: CurrentRunHandle;
let testAgentId: string;
let chatId: string;
let listenerClientId: string;
let pg: PgClient;

beforeAll(async () => {
  handle = readCurrentHandle();
  const creds = readCredentialsOrThrow(handle);
  listenerClientId = `client_${randomBytes(4).toString("hex")}`;

  // Pre-seed the listener's `clients` row through PG — the WS handshake's
  // `client:register` CLAIMs this id rather than inventing a new one. Direct
  // PG write is intentional: the public API doesn't expose a "create empty
  // client row" endpoint (clients are normally bootstrapped during the
  // CLI's `connect` flow, which we don't want to run for a pure WS test).
  pg = new PgClient({ connectionString: handle.databaseUrl });
  await pg.connect();
  await pg.query("INSERT INTO clients (id, user_id, organization_id) VALUES ($1, $2, $3)", [
    listenerClientId,
    creds.userId,
    creds.organizationId,
  ]);

  const created = await authedJson<{ uuid: string }>(
    handle.serverBaseUrl,
    creds.accessToken,
    "POST",
    `/api/v1/orgs/${encodeURIComponent(creds.organizationId)}/agents`,
    {
      name: `e2e-pull-${randomBytes(3).toString("hex")}`,
      type: "agent",
      displayName: "Reconnect-continuity target",
      clientId: listenerClientId,
    },
    201,
  );
  testAgentId = created.uuid;

  const chat = await authedJson<{ chatId: string }>(
    handle.serverBaseUrl,
    creds.accessToken,
    "POST",
    `/api/v1/orgs/${encodeURIComponent(creds.organizationId)}/chats`,
    { participantIds: [testAgentId] },
    201,
  );
  chatId = chat.chatId;
});

afterAll(async () => {
  await pg.end().catch(() => undefined);
});

async function postMessage(content: string): Promise<string> {
  const creds = readCredentialsOrThrow(handle);
  const sent = await authedJson<{ id: string }>(
    handle.serverBaseUrl,
    creds.accessToken,
    "POST",
    `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
    { format: "text", content },
    201,
  );
  return sent.id;
}

async function openListener(): Promise<WsListener> {
  const creds = readCredentialsOrThrow(handle);
  return connectWsListener({
    serverBaseUrl: handle.serverBaseUrl,
    accessToken: creds.accessToken,
    clientId: listenerClientId,
    bindAgents: [{ agentId: testAgentId }],
  });
}

function inboxFrames(listener: WsListener): InboxDeliverFrame[] {
  return listener.frames
    .filter((f): f is WsListener["frames"][number] & InboxDeliverFrame => f.type === "inbox:deliver")
    .map((f) => f as unknown as InboxDeliverFrame);
}

describe("inbox ack + reconnect continuity", () => {
  it("an acked entry is not re-pushed after reconnect; new messages still flow", async () => {
    // Stage 1: listener A receives message #1 and acks it.
    const listenerA = await openListener();
    const firstId = await postMessage(`ack-test-1 ${randomBytes(2).toString("hex")}`);
    const firstFrame = (await listenerA.waitFor(
      (f) => f.type === "inbox:deliver" && (f as Partial<InboxDeliverFrame>).message?.id === firstId,
      5_000,
    )) as unknown as InboxDeliverFrame;
    listenerA.send({ type: "inbox:ack", entryId: firstFrame.entryId });

    // Small pause so the server-side ack handler actually persists the
    // status change before we yank the socket.
    await new Promise<void>((r) => setTimeout(r, 250));
    await listenerA.close();

    // Stage 2: listener B reconnects on the same clientId. After the
    // backlog drain races to completion, we expect zero re-deliveries of
    // the already-acked entry. 1s wall-clock is enough for the bind-time
    // drain on a warm local stack.
    const listenerB = await openListener();
    try {
      await new Promise<void>((r) => setTimeout(r, 1_000));
      expect(inboxFrames(listenerB)).toHaveLength(0);

      // Stage 3: confirm forward-direction delivery still works on the
      // reconnected socket — the listener's clientId hasn't been somehow
      // "burned" by the ack/close cycle.
      const secondId = await postMessage(`ack-test-2 ${randomBytes(2).toString("hex")}`);
      const secondFrame = (await listenerB.waitFor(
        (f) => f.type === "inbox:deliver" && (f as Partial<InboxDeliverFrame>).message?.id === secondId,
        5_000,
      )) as unknown as InboxDeliverFrame;
      expect(secondFrame.entryId).toBeGreaterThan(firstFrame.entryId);

      // Ack the second one too so we leave the inbox tidy for any
      // downstream observer.
      listenerB.send({ type: "inbox:ack", entryId: secondFrame.entryId });
    } finally {
      await listenerB.close();
    }
  });
});
