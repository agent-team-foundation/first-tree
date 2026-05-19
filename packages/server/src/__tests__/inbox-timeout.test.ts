import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as inboxService from "../services/inbox.js";
import { createTestAgent, useTestApp } from "./helpers.js";

describe("Inbox Timeout Reset", () => {
  const getApp = useTestApp();

  it("resets timed-out delivered entries to pending", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "timeout-a1" });
    const a2 = await createTestAgent(app, { name: "timeout-a2" });

    const chatRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.agent.uuid],
    });
    const chatId = chatRes.json().id;

    // mention_only direct (migration 0029) — @a2 to land an active entry.
    await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: `@${a2.agent.name} Timeout test`,
    });

    const pollRes = await a2.request("GET", "/api/v1/agent/inbox");
    const entries = pollRes.json();
    expect(entries).toHaveLength(1);
    const entryId = entries[0].id;

    await app.db.execute(sql`
      UPDATE inbox_entries SET delivered_at = NOW() - INTERVAL '10 minutes'
      WHERE id = ${entryId}
    `);

    const result = await inboxService.resetTimedOutEntries(app.db, 300, 3);
    expect(result.reset).toBe(1);
    expect(result.failed).toBe(0);

    const pollRes2 = await a2.request("GET", "/api/v1/agent/inbox");
    expect(pollRes2.json()).toHaveLength(1);
  });

  it("marks entries as failed after max retries", async () => {
    const app = getApp();
    const a1 = await createTestAgent(app, { name: "maxretry-a1" });
    const a2 = await createTestAgent(app, { name: "maxretry-a2" });

    const chatRes = await a1.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [a2.agent.uuid],
    });
    const chatId = chatRes.json().id;

    // mention_only direct (migration 0029) — @a2 to land an active entry.
    await a1.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: `@${a2.agent.name} Fail test`,
    });

    const pollRes = await a2.request("GET", "/api/v1/agent/inbox");
    const entryId = pollRes.json()[0].id;

    await app.db.execute(sql`
      UPDATE inbox_entries SET
        delivered_at = NOW() - INTERVAL '10 minutes',
        retry_count = 3
      WHERE id = ${entryId}
    `);

    const result = await inboxService.resetTimedOutEntries(app.db, 300, 3);
    expect(result.reset).toBe(0);
    expect(result.failed).toBe(1);

    const pollRes2 = await a2.request("GET", "/api/v1/agent/inbox");
    expect(pollRes2.json()).toHaveLength(0);
  });
});
