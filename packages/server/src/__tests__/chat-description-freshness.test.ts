import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createChat, updateChatMetadata } from "../services/chat.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * Task-header data contract: the chat `description` carries its OWN freshness
 * (`description_updated_at`) and attribution (`description_updated_by`),
 * distinct from the row-level `updatedAt` that a topic edit also bumps. Only a
 * *real* description change stamps them, so the header's "X ago · who" line and
 * its unread/auto-expand logic reflect the actual last description edit — never
 * a topic rename or a no-op re-write. The same "did it really change" signal
 * gates the realtime `chat:updated` notify that refreshes an open client.
 */
describe("chat description freshness — stamping (updateChatMetadata)", () => {
  const getApp = useTestApp();

  async function setupChat(app: FastifyInstance) {
    const owner = await createTestAgent(app, { type: "human", displayName: "Owner" });
    const maintainer = await createTestAgent(app, { type: "agent", displayName: "Maintainer Bot" });
    const other = await createTestAgent(app, { type: "agent", displayName: "Other Bot" });
    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [maintainer.agent.uuid, other.agent.uuid],
    });
    return { maintainer, other, chat };
  }

  it("first description write stamps descriptionUpdatedAt + descriptionUpdatedBy and reports the change", async () => {
    const app = getApp();
    const { maintainer, chat } = await setupChat(app);
    const r1 = await updateChatMetadata(app.db, chat.id, { description: "First summary" }, maintainer.agent.uuid);
    expect(r1.descriptionChanged).toBe(true);
    expect(r1.chat.description).toBe("First summary");
    expect(r1.chat.descriptionUpdatedAt).toBeInstanceOf(Date);
    expect(r1.chat.descriptionUpdatedBy).toBe(maintainer.agent.uuid);
  });

  it("a no-op re-write of identical text does NOT bump freshness, attribution, or report a change", async () => {
    const app = getApp();
    const { maintainer, other, chat } = await setupChat(app);
    const r1 = await updateChatMetadata(app.db, chat.id, { description: "Same text" }, maintainer.agent.uuid);
    const t1 = r1.chat.descriptionUpdatedAt?.getTime();
    const r2 = await updateChatMetadata(app.db, chat.id, { description: "Same text" }, other.agent.uuid);
    expect(r2.descriptionChanged).toBe(false);
    expect(r2.chat.descriptionUpdatedAt?.getTime()).toBe(t1);
    expect(r2.chat.descriptionUpdatedBy).toBe(maintainer.agent.uuid);
  });

  it("a topic-only patch leaves description freshness untouched and reports no description change", async () => {
    const app = getApp();
    const { maintainer, other, chat } = await setupChat(app);
    const r1 = await updateChatMetadata(app.db, chat.id, { description: "Body" }, maintainer.agent.uuid);
    const t1 = r1.chat.descriptionUpdatedAt?.getTime();
    const r2 = await updateChatMetadata(app.db, chat.id, { topic: "Renamed" }, other.agent.uuid);
    expect(r2.descriptionChanged).toBe(false);
    expect(r2.chat.topic).toBe("Renamed");
    expect(r2.chat.descriptionUpdatedAt?.getTime()).toBe(t1);
    expect(r2.chat.descriptionUpdatedBy).toBe(maintainer.agent.uuid);
  });

  it("a real description change re-stamps with the new actor and reports the change", async () => {
    const app = getApp();
    const { maintainer, other, chat } = await setupChat(app);
    await updateChatMetadata(app.db, chat.id, { description: "v1" }, maintainer.agent.uuid);
    const r2 = await updateChatMetadata(app.db, chat.id, { description: "v2" }, other.agent.uuid);
    expect(r2.descriptionChanged).toBe(true);
    expect(r2.chat.description).toBe("v2");
    expect(r2.chat.descriptionUpdatedBy).toBe(other.agent.uuid);
    expect(r2.chat.descriptionUpdatedAt).toBeInstanceOf(Date);
  });

  it("clearing the description counts as a change and attributes to the clearer", async () => {
    const app = getApp();
    const { maintainer, other, chat } = await setupChat(app);
    await updateChatMetadata(app.db, chat.id, { description: "something" }, maintainer.agent.uuid);
    const r2 = await updateChatMetadata(app.db, chat.id, { description: "" }, other.agent.uuid);
    expect(r2.descriptionChanged).toBe(true);
    expect(r2.chat.description).toBeNull();
    expect(r2.chat.descriptionUpdatedBy).toBe(other.agent.uuid);
  });
});

describe("chat description freshness — detail exposure (GET /api/v1/chats/:id)", () => {
  const getApp = useTestApp();

  it("exposes descriptionUpdatedAt + resolved updater name, with null lastReadAt before first read", async () => {
    const app = getApp();
    const caller = await createTestAgent(app, { type: "human", displayName: "Caller" });
    const maintainer = await createTestAgent(app, { type: "agent", displayName: "Maintainer Bot" });
    const chat = await createChat(app.db, caller.agent.uuid, {
      type: "group",
      participantIds: [maintainer.agent.uuid],
    });
    await updateChatMetadata(app.db, chat.id, { description: "Hello **world**" }, maintainer.agent.uuid);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${chat.id}`,
      headers: { authorization: `Bearer ${caller.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      description: string | null;
      descriptionUpdatedAt: string | null;
      descriptionUpdatedByName: string | null;
      lastReadAt: string | null;
    };
    expect(body.description).toBe("Hello **world**");
    expect(typeof body.descriptionUpdatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.descriptionUpdatedAt ?? ""))).toBe(false);
    expect(body.descriptionUpdatedByName).toBe("Maintainer Bot");
    expect(body.lastReadAt).toBeNull();
  });

  it("populates lastReadAt after the caller marks the chat read", async () => {
    const app = getApp();
    const caller = await createTestAgent(app, { type: "human", displayName: "Caller" });
    const maintainer = await createTestAgent(app, { type: "agent", displayName: "Maintainer Bot" });
    const chat = await createChat(app.db, caller.agent.uuid, {
      type: "group",
      participantIds: [maintainer.agent.uuid],
    });
    await updateChatMetadata(app.db, chat.id, { description: "Body" }, maintainer.agent.uuid);
    const readRes = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chat.id}/read`,
      headers: { authorization: `Bearer ${caller.accessToken}` },
    });
    expect(readRes.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${chat.id}`,
      headers: { authorization: `Bearer ${caller.accessToken}` },
    });
    const body = res.json() as { lastReadAt: string | null };
    expect(typeof body.lastReadAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.lastReadAt ?? ""))).toBe(false);
  });

  it("returns null freshness for a chat whose description was never set", async () => {
    const app = getApp();
    const caller = await createTestAgent(app, { type: "human", displayName: "Caller" });
    const peer = await createTestAgent(app, { type: "agent", displayName: "Peer Bot" });
    const chat = await createChat(app.db, caller.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${chat.id}`,
      headers: { authorization: `Bearer ${caller.accessToken}` },
    });
    const body = res.json() as { descriptionUpdatedAt: string | null; descriptionUpdatedByName: string | null };
    expect(body.descriptionUpdatedAt).toBeNull();
    expect(body.descriptionUpdatedByName).toBeNull();
  });
});

describe("chat description freshness — realtime notify (PATCH /api/v1/chats/:id)", () => {
  const getApp = useTestApp();

  it("emits chat:updated on a real description change, but not on a no-op or a topic-only edit", async () => {
    const app = getApp();
    const caller = await createTestAgent(app, { type: "human", displayName: "Caller" });
    const peer = await createTestAgent(app, { type: "agent", displayName: "Peer Bot" });
    const chat = await createChat(app.db, caller.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });

    const notifySpy = vi.spyOn(app.notifier, "notifyChatUpdated").mockResolvedValue();
    const patch = (payload: Record<string, unknown>) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/chats/${chat.id}`,
        headers: { authorization: `Bearer ${caller.accessToken}` },
        payload,
      });

    // Real description change → exactly one realtime kick for this chat.
    const first = await patch({ description: "first summary" });
    expect(first.statusCode).toBe(200);
    expect(notifySpy).toHaveBeenCalledWith(chat.id);
    expect(notifySpy).toHaveBeenCalledTimes(1);

    // No-op re-write of identical text → no further notify.
    await patch({ description: "first summary" });
    expect(notifySpy).toHaveBeenCalledTimes(1);

    // Topic-only edit → no description notify.
    await patch({ topic: "Renamed" });
    expect(notifySpy).toHaveBeenCalledTimes(1);

    notifySpy.mockRestore();
  });
});
