import { describe, expect, it } from "vitest";
import { createChat, getChatDetail } from "../services/chat.js";
import { sendMessage } from "../services/message.js";
import { createTestAgent, TEST_AVATAR_AUTHORITY_TAG, useTestApp } from "./helpers.js";

/**
 * v1.7 follow-up to §四 改造 3 — server-resolved `title` field on
 * `GET /agent/chats/:chatId`.
 *
 * Previous implementation: `services/chat.ts:getChatDetail` returned the
 * chat row + raw chatMembership participants but NO `title` /
 * `firstMessagePreview`. The shared `chatDetailSchema` required both,
 * but the agent route handler never validated the response shape so
 * undefined fields silently flowed through. Client-side
 * `chat-context.ts` then read `detail.title === undefined` and
 * rendered no Title row in CLAUDE.md — exactly the PR #393 dogfood
 * symptom ("agent doesn't know the chat title").
 *
 * Fix: `getChatDetail` now computes `title` via `resolveChatTitle` over
 * `topic > firstMessageSummary > participant join`, and surfaces
 * `firstMessagePreview` for callers that want to render it directly.
 */

describe("getChatDetail — server-resolved title (v1.7)", () => {
  const getApp = useTestApp();

  it("returns the chat's explicit topic verbatim when set", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peer = await createTestAgent(app, { type: "agent" });
    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
      topic: "Q2 launch",
    });
    const detail = await getChatDetail(app.db, chat.id, owner.agent.uuid, TEST_AVATAR_AUTHORITY_TAG);
    expect(detail.topic).toBe("Q2 launch");
    expect(detail.title).toBe("Q2 launch");
  });

  it("falls back to the first message preview when topic is null", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peer = await createTestAgent(app, { type: "agent" });
    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });
    await sendMessage(
      app.db,
      chat.id,
      owner.agent.uuid,
      {
        source: "api",
        format: "text",
        content: "Let's coordinate the design review tomorrow",
      },
      { allowRecipientlessSend: true },
    );
    const detail = await getChatDetail(app.db, chat.id, owner.agent.uuid, TEST_AVATAR_AUTHORITY_TAG);
    expect(detail.topic).toBeNull();
    expect(detail.title).toBe("Let's coordinate the design review tomorrow");
    expect(detail.firstMessagePreview).toBe("Let's coordinate the design review tomorrow");
  });

  it("falls back to participant displayName join when topic is null AND no messages", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human", displayName: "Alice" });
    const peer = await createTestAgent(app, { type: "agent", displayName: "Bob Bot" });
    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peer.agent.uuid],
    });
    const detail = await getChatDetail(app.db, chat.id, owner.agent.uuid, TEST_AVATAR_AUTHORITY_TAG);
    expect(detail.topic).toBeNull();
    expect(detail.firstMessagePreview).toBeNull();
    // Excludes self (alice was the requester) — only Bob Bot survives.
    expect(detail.title).toBe("Bob Bot");
  });

  it("API integration: GET /agent/chats/:chatId returns `title` populated", async () => {
    const app = getApp();
    // `human` agents lack `clientId` pinning and are blocked from the
    // agent path; use an autonomous agent as the caller instead.
    const caller = await createTestAgent(app, { type: "agent", displayName: "Owner Bot" });
    const peer = await createTestAgent(app, { type: "agent", displayName: "Bot Peer" });

    const chatRes = await caller.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [peer.agent.uuid],
    });
    const chatId = chatRes.json().id as string;

    const res = await caller.request("GET", `/api/v1/agent/chats/${chatId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { title?: string; topic: string | null; firstMessagePreview?: string | null };
    expect(body.topic).toBeNull();
    expect(typeof body.title).toBe("string");
    expect(body.title?.length ?? 0).toBeGreaterThan(0);
    // Contract: server-resolved title is never empty when topic is null.
  });
});
