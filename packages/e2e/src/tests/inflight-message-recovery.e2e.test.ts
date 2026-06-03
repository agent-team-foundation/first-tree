import { randomBytes } from "node:crypto";
import type { InboxDeliverFrame } from "@first-tree/shared";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CurrentRunHandle, readCredentialsOrThrow, readCurrentHandle } from "../framework/current-handle.js";
import { authedJson } from "../framework/server-driver/http.js";
import { connectWsListener, type WsListener } from "../framework/server-driver/ws.js";

/**
 * In-flight message recovery e2e — verifies that a message delivered but
 * never acked (the classic "client died mid-turn" scenario) is re-pushed
 * the next time the client binds the agent.
 *
 * This is the wire-level proof for the server half of the design in
 * docs/inflight-message-recovery-design.md: at every `agent:bind` the
 * server resets every `delivered` row back to `pending` and drains, so a
 * fresh socket on the same clientId picks the stuck row up immediately
 * (no 300s timeout reaper any more).
 *
 * Test shape mirrors `inbox-pull-resume.e2e.test.ts` but adds:
 *
 *   1. Redelivery on reconnect without ack (the inbox-pull test
 *      deliberately skipped this because it required waiting 300s under
 *      the old reaper-based recovery path).
 *   2. Network-blip dedupe — two reconnects in a row both redeliver the
 *      same entryId; on the second reconnect the client *would* dedupe in
 *      memory, but our wire listener is fresh so we just confirm the
 *      server keeps redelivering until acked.
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
      name: `e2e-inflight-${randomBytes(3).toString("hex")}`,
      type: "agent",
      displayName: "In-flight recovery target",
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
    { format: "text", content, metadata: { mentions: [testAgentId] } },
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

describe("in-flight message recovery — bind resets delivered → pending", () => {
  it("a message left UN-acked is redelivered on the next bind, NOT lost to the 300s reaper", async () => {
    // Stage 1: listener A receives the message but never acks it. Simulate
    // a client crash by closing the socket while the entry is still
    // `delivered` server-side.
    const listenerA = await openListener();
    const messageId = await postMessage(`inflight-1 ${randomBytes(2).toString("hex")}`);
    const firstFrame = (await listenerA.waitFor(
      (f) => f.type === "inbox:deliver" && (f as Partial<InboxDeliverFrame>).message?.id === messageId,
      5_000,
    )) as unknown as InboxDeliverFrame;
    const firstEntryId = firstFrame.entryId;
    await listenerA.close();

    // Stage 2: listener B reconnects on the same clientId + agentId. The
    // server's `agent:bind` handler flips every still-`delivered` row for
    // this inbox back to `pending` and drains, so the unacked entry from
    // listener A must arrive within the bind-time drain window (sub-second
    // on a warm local stack).
    const listenerB = await openListener();
    try {
      const redeliveredFrame = (await listenerB.waitFor(
        (f) => f.type === "inbox:deliver" && (f as Partial<InboxDeliverFrame>).message?.id === messageId,
        5_000,
      )) as unknown as InboxDeliverFrame;
      // entryId is stable across the reset (we update status only, never
      // re-insert) — pin it so a future refactor that re-inserts on
      // recovery breaks loudly.
      expect(redeliveredFrame.entryId).toBe(firstEntryId);
      expect(redeliveredFrame.message.id).toBe(messageId);

      // Stage 3: ack from listener B. The next reconnect must NOT see the
      // entry again — proving ack persisted and recovery is bounded to
      // genuinely-unfinished work.
      listenerB.send({ type: "inbox:ack", entryId: redeliveredFrame.entryId });
      await new Promise<void>((r) => setTimeout(r, 250));
    } finally {
      await listenerB.close();
    }

    const listenerC = await openListener();
    try {
      await new Promise<void>((r) => setTimeout(r, 1_000));
      const seen = listenerC.frames.filter(
        (f) => f.type === "inbox:deliver" && (f as Partial<InboxDeliverFrame>).message?.id === messageId,
      );
      expect(seen).toHaveLength(0);
    } finally {
      await listenerC.close();
    }
  });

  it("mid-turn injects: A acked but B left UN-acked is redelivered on the next bind", async () => {
    // Two messages sent back-to-back into the same chat → both arrive on
    // listener A. The listener acks only the FIRST (simulating "handler
    // closed turn for A, but B's turn was mid-flight when the client
    // crashed"). After reconnect, listener B must see ONLY message B
    // redelivered — not A. This pins the per-turn shift semantics: a
    // markCompleted for A's turn doesn't ack B's entry.
    const listenerA = await openListener();
    const messageAId = await postMessage(`inflight-midturn-A ${randomBytes(2).toString("hex")}`);
    const messageBId = await postMessage(`inflight-midturn-B ${randomBytes(2).toString("hex")}`);

    const frameA = (await listenerA.waitFor(
      (f) => f.type === "inbox:deliver" && (f as Partial<InboxDeliverFrame>).message?.id === messageAId,
      5_000,
    )) as unknown as InboxDeliverFrame;
    const frameB = (await listenerA.waitFor(
      (f) => f.type === "inbox:deliver" && (f as Partial<InboxDeliverFrame>).message?.id === messageBId,
      5_000,
    )) as unknown as InboxDeliverFrame;

    // Ack A only — leave B as `delivered`. Then drop the socket.
    listenerA.send({ type: "inbox:ack", entryId: frameA.entryId });
    await new Promise<void>((r) => setTimeout(r, 250));
    await listenerA.close();

    // On reconnect, bind reset only flips still-`delivered` rows; A's
    // acked row stays acked, B's delivered row goes pending → re-pushed.
    const listenerB = await openListener();
    try {
      const redelivered = (await listenerB.waitFor(
        (f) => f.type === "inbox:deliver" && (f as Partial<InboxDeliverFrame>).message?.id === messageBId,
        5_000,
      )) as unknown as InboxDeliverFrame;
      expect(redelivered.entryId).toBe(frameB.entryId);

      // A must NOT be re-pushed.
      const aReplay = listenerB.frames.filter(
        (f) => f.type === "inbox:deliver" && (f as Partial<InboxDeliverFrame>).message?.id === messageAId,
      );
      expect(aReplay).toHaveLength(0);

      // Tidy up.
      listenerB.send({ type: "inbox:ack", entryId: redelivered.entryId });
      await new Promise<void>((r) => setTimeout(r, 250));
    } finally {
      await listenerB.close();
    }
  });

  it("two reconnects in a row both redeliver the same entryId until an ack lands", async () => {
    // Network-blip / flap scenario: the client reconnects multiple times
    // before successfully acking. Each bind triggers another reset +
    // re-push of the same row. The client-side Deduplicator is what tames
    // the noise; the wire just keeps re-delivering.
    const listenerA = await openListener();
    const messageId = await postMessage(`inflight-flap ${randomBytes(2).toString("hex")}`);
    const firstFrame = (await listenerA.waitFor(
      (f) => f.type === "inbox:deliver" && (f as Partial<InboxDeliverFrame>).message?.id === messageId,
      5_000,
    )) as unknown as InboxDeliverFrame;
    const entryId = firstFrame.entryId;
    await listenerA.close();

    const listenerB = await openListener();
    const secondFrame = (await listenerB.waitFor(
      (f) => f.type === "inbox:deliver" && (f as Partial<InboxDeliverFrame>).message?.id === messageId,
      5_000,
    )) as unknown as InboxDeliverFrame;
    expect(secondFrame.entryId).toBe(entryId);
    await listenerB.close();

    const listenerC = await openListener();
    try {
      const thirdFrame = (await listenerC.waitFor(
        (f) => f.type === "inbox:deliver" && (f as Partial<InboxDeliverFrame>).message?.id === messageId,
        5_000,
      )) as unknown as InboxDeliverFrame;
      expect(thirdFrame.entryId).toBe(entryId);
      // Final ack tidies up so this test doesn't leave server-side
      // `delivered` debris behind.
      listenerC.send({ type: "inbox:ack", entryId: thirdFrame.entryId });
      await new Promise<void>((r) => setTimeout(r, 250));
    } finally {
      await listenerC.close();
    }
  });
});
