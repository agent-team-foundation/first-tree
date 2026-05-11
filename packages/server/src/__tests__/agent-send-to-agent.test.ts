import { describe, expect, it } from "vitest";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Agent Send-to-Agent API", () => {
  const getApp = useTestApp();

  it("sends a message to another agent (auto-creates direct chat)", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "sta-a1" });
    const a2 = await createTestAgent(app, { name: "sta-a2" });

    const res = await a1.request("POST", `/api/v1/agent/agents/${a2.agent.name}/messages`, {
      format: "text",
      content: "Hello agent!",
    });
    expect(res.statusCode).toBe(201);
    const msg = res.json();
    // Server prepends @<targetName> so the recipient always sees the explicit
    // mention regardless of chat type — see agent-send-mention-injection.test.ts.
    expect(msg.content).toBe(`@${a2.agent.name} Hello agent!`);
    expect(msg.chatId).toBeDefined();

    const pollRes = await a2.request("GET", "/api/v1/agent/inbox");
    expect(pollRes.statusCode).toBe(200);
    const entries = pollRes.json();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].message.content).toBe(`@${a2.agent.name} Hello agent!`);
  });

  it("reuses existing direct chat for same pair", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "reuse-a1" });
    const { agent: a2 } = await createTestAgent(app, { name: "reuse-a2" });

    const res1 = await a1.request("POST", `/api/v1/agent/agents/${a2.name}/messages`, {
      format: "text",
      content: "First message",
    });
    const chatId1 = res1.json().chatId;

    const res2 = await a1.request("POST", `/api/v1/agent/agents/${a2.name}/messages`, {
      format: "text",
      content: "Second message",
    });
    const chatId2 = res2.json().chatId;

    expect(chatId1).toBe(chatId2);
  });

  it("rejects sending to non-existent agent", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "noagent-a1" });

    const res = await a1.request("POST", "/api/v1/agent/agents/non-existent/messages", {
      format: "text",
      content: "Hello?",
    });
    expect(res.statusCode).toBe(404);
  });

  it("hints at using name when target looks like a uuid (common LLM mistake)", async () => {
    // Agents routinely paste uuids harvested from `agent chats` / participant
    // listings. The 404 error must nudge them to use the name so the next
    // attempt self-corrects rather than looping.
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "uuidhint-a1" });

    const res = await a1.request("POST", "/api/v1/agent/agents/019db446-bdb7-71e6-860c-4204df2db1f6/messages", {
      format: "text",
      content: "Hello?",
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toMatch(/not found/i);
    expect(body.error).toMatch(/name, not a uuid/i);
    expect(body.error).toMatch(/agent list/);
  });

  it("does NOT append the uuid hint when the target is a plain name", async () => {
    // Plain-name 404s are a different failure mode (typo / wrong org) and
    // should not be noised up with uuid guidance.
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "namehint-a1" });

    const res = await a1.request("POST", "/api/v1/agent/agents/typo-target/messages", {
      format: "text",
      content: "Hello?",
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toMatch(/not found/i);
    expect(body.error).not.toMatch(/uuid/i);
  });

  it("sends with replyTo fields", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "reply-a1" });
    const { agent: a2 } = await createTestAgent(app, { name: "reply-a2" });

    const res = await a1.request("POST", `/api/v1/agent/agents/${a2.name}/messages`, {
      format: "text",
      content: "Need approval",
      replyToInbox: a1.agent.inboxId,
      replyToChat: "some-chat-id",
    });
    expect(res.statusCode).toBe(201);
    const msg = res.json();
    expect(msg.replyToInbox).toBe(a1.agent.inboxId);
    expect(msg.replyToChat).toBe("some-chat-id");
  });
});
