import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import * as inboxService from "../services/inbox.js";
import { createTestAgent, createTestApp } from "./helpers.js";

describe("Inbox Timeout Reset", () => {
  const appPromise = createTestApp();
  afterAll(async () => (await appPromise).close());

  it("resets timed-out delivered entries to pending", async () => {
    const app = await appPromise;
    const { token: t1 } = await createTestAgent(app, { id: "timeout-a1" });
    const { agent: a2, token: t2 } = await createTestAgent(app, { id: "timeout-a2" });

    // Create chat and send message
    const chatRes = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chats",
      headers: { authorization: `Bearer ${t1}` },
      payload: { type: "direct", participantIds: [a2.id] },
    });
    const chatId = chatRes.json().id;

    await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${t1}` },
      payload: { format: "text", content: "Timeout test" },
    });

    // Poll to deliver
    const pollRes = await app.inject({
      method: "GET",
      url: "/api/v1/agent/inbox",
      headers: { authorization: `Bearer ${t2}` },
    });
    const entries = pollRes.json();
    expect(entries).toHaveLength(1);
    const entryId = entries[0].id;

    // Manually set delivered_at to the past to simulate timeout
    await app.db.execute(sql`
      UPDATE inbox_entries SET delivered_at = NOW() - INTERVAL '10 minutes'
      WHERE id = ${entryId}
    `);

    // Run timeout reset with 5-minute timeout
    const result = await inboxService.resetTimedOutEntries(app.db, 300, 3);
    expect(result.reset).toBe(1);
    expect(result.failed).toBe(0);

    // Entry should be pending again — pollable
    const pollRes2 = await app.inject({
      method: "GET",
      url: "/api/v1/agent/inbox",
      headers: { authorization: `Bearer ${t2}` },
    });
    expect(pollRes2.json()).toHaveLength(1);
  });

  it("marks entries as failed after max retries", async () => {
    const app = await appPromise;
    const { token: t1 } = await createTestAgent(app, { id: "maxretry-a1" });
    const { agent: a2, token: t2 } = await createTestAgent(app, { id: "maxretry-a2" });

    const chatRes = await app.inject({
      method: "POST",
      url: "/api/v1/agent/chats",
      headers: { authorization: `Bearer ${t1}` },
      payload: { type: "direct", participantIds: [a2.id] },
    });
    const chatId = chatRes.json().id;

    await app.inject({
      method: "POST",
      url: `/api/v1/agent/chats/${chatId}/messages`,
      headers: { authorization: `Bearer ${t1}` },
      payload: { format: "text", content: "Fail test" },
    });

    // Poll to deliver
    const pollRes = await app.inject({
      method: "GET",
      url: "/api/v1/agent/inbox",
      headers: { authorization: `Bearer ${t2}` },
    });
    const entryId = pollRes.json()[0].id;

    // Set retry_count to max and delivered_at to past
    await app.db.execute(sql`
      UPDATE inbox_entries SET
        delivered_at = NOW() - INTERVAL '10 minutes',
        retry_count = 3
      WHERE id = ${entryId}
    `);

    const result = await inboxService.resetTimedOutEntries(app.db, 300, 3);
    expect(result.reset).toBe(0);
    expect(result.failed).toBe(1);

    // Entry should not be pollable (it's failed)
    const pollRes2 = await app.inject({
      method: "GET",
      url: "/api/v1/agent/inbox",
      headers: { authorization: `Bearer ${t2}` },
    });
    expect(pollRes2.json()).toHaveLength(0);
  });
});
