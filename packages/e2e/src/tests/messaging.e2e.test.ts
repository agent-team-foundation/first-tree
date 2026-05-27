import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { type CurrentRunHandle, readCredentialsOrThrow, readCurrentHandle } from "../framework/current-handle.js";

/**
 * Messaging e2e — exercises the user-scoped HTTP chat surface end-to-end:
 *
 *   POST /api/v1/orgs/:orgId/agents              — create the autonomous
 *                                                  test agent via the
 *                                                  PUBLIC API (this is the
 *                                                  validation surface we
 *                                                  want exercised — R-RUN,
 *                                                  name regex, manager-in-
 *                                                  org check, etc.). The
 *                                                  credentials helper only
 *                                                  pre-seeds {user, human
 *                                                  agent, member, client}.
 *   POST /api/v1/orgs/:orgId/chats               — create a chat with the
 *                                                  new autonomous agent.
 *   POST /api/v1/chats/:chatId/messages          — caller speaks as their
 *                                                  human agent (resolved
 *                                                  server-side from the user
 *                                                  JWT + membership).
 *   GET  /api/v1/chats/:chatId/messages          — list back to confirm both
 *                                                  the original message and
 *                                                  the in-reply-to follow-up
 *                                                  persisted in the right
 *                                                  order with the threading
 *                                                  pointer intact.
 *
 * Requires `E2E_WITH_CLIENT=1` so globalSetup provisioned a user / member /
 * human-agent / client / token bundle.
 */

let handle: CurrentRunHandle;
let chatId: string;
let testAgentId: string;

beforeAll(async () => {
  handle = readCurrentHandle();
  const creds = readCredentialsOrThrow(handle);

  const agentRes = await fetch(`${handle.serverBaseUrl}/api/v1/orgs/${creds.organizationId}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.accessToken}` },
    body: JSON.stringify({
      name: `e2e-msg-${randomBytes(3).toString("hex")}`,
      type: "agent",
      displayName: "E2E Messaging Target",
      clientId: creds.clientId,
    }),
  });
  if (agentRes.status !== 201) {
    throw new Error(`failed to create test agent: ${agentRes.status} ${await agentRes.text()}`);
  }
  const agentBody = (await agentRes.json()) as { uuid: string };
  if (!agentBody.uuid) throw new Error(`agent create response missing uuid: ${JSON.stringify(agentBody)}`);
  testAgentId = agentBody.uuid;

  const createRes = await fetch(`${handle.serverBaseUrl}/api/v1/orgs/${creds.organizationId}/chats`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.accessToken}` },
    body: JSON.stringify({ participantIds: [testAgentId] }),
  });
  if (createRes.status !== 201) {
    throw new Error(`failed to create chat: ${createRes.status} ${await createRes.text()}`);
  }
  const body = (await createRes.json()) as { chatId: string };
  if (!body.chatId) throw new Error(`chat create response missing chatId: ${JSON.stringify(body)}`);
  chatId = body.chatId;
});

describe("M2 messaging — user-scoped HTTP chat send + replyTo", () => {
  it("sends a text message and gets a 201 with a fresh message id", async () => {
    const creds = readCredentialsOrThrow(handle);
    const res = await fetch(`${handle.serverBaseUrl}/api/v1/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.accessToken}` },
      body: JSON.stringify({ format: "text", content: "hello from e2e" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; chatId: string; senderId: string };
    // Message ids are UUID v7 (see services/message.ts) — match the canonical
    // 8-4-4-4-12 form anchored, not a loose substring.
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body.chatId).toBe(chatId);
    expect(body.senderId).toBe(creds.humanAgentId);
  });

  it("replyTo threads the second message onto the first via inReplyTo", async () => {
    const creds = readCredentialsOrThrow(handle);

    const first = await fetch(`${handle.serverBaseUrl}/api/v1/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.accessToken}` },
      body: JSON.stringify({ format: "text", content: "parent" }),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string };

    const reply = await fetch(`${handle.serverBaseUrl}/api/v1/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.accessToken}` },
      body: JSON.stringify({ format: "text", content: "child", inReplyTo: firstBody.id }),
    });
    expect(reply.status).toBe(201);
    const replyBody = (await reply.json()) as { id: string };
    expect(replyBody.id).not.toBe(firstBody.id);

    // List the chat back and confirm both messages persisted in order and
    // the second carries the inReplyTo pointer to the first.
    const list = await fetch(`${handle.serverBaseUrl}/api/v1/chats/${chatId}/messages`, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      items: Array<{ id: string; inReplyTo: string | null }>;
    };
    const byId = new Map(listBody.items.map((m) => [m.id, m]));
    expect(byId.has(firstBody.id)).toBe(true);
    expect(byId.get(replyBody.id)?.inReplyTo).toBe(firstBody.id);
  });
});
