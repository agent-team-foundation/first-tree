import { describe, expect, it } from "vitest";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * `sendToAgent` is no longer a routing primitive. Hub keeps a single
 * group-chat model (see first-tree-context PR #281) and the legacy
 * `--direct` opt-in / `findOrCreateDirectChat` fallback are gone. The
 * endpoint's only job now is to resolve the recipient name and refuse with
 * `AGENT_SEND_NON_MEMBER` pointing callers at `chat add-participant`. The
 * canonical send path is `POST /api/v1/agent/chats/:chatId/messages`
 * against a chat the caller has already joined.
 */
describe("Agent Send-to-Agent API — name-resolve + non-member refusal", () => {
  const getApp = useTestApp();

  it("rejects sending to a non-existent agent", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "noagent-a1" });

    const res = await a1.request("POST", "/api/v1/agent/agents/non-existent/messages", {
      format: "text",
      content: "Hello?",
    });
    expect(res.statusCode).toBe(404);
  });

  it("hints at using name when target looks like a uuid (common LLM mistake)", async () => {
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

  it("refuses an existing agent that is not a member of the caller's current chat with AGENT_SEND_NON_MEMBER", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { name: "non-member-s" });
    const { agent: peer } = await createTestAgent(app, { name: "non-member-p" });

    const res = await sender.request("POST", `/api/v1/agent/agents/${peer.name}/messages`, {
      format: "text",
      content: "no hint",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/add-participant/);
  });
});
