import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agents } from "../db/schema/agents.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { createTestAgent, useTestApp } from "./helpers.js";

type App = ReturnType<ReturnType<typeof useTestApp>>;

/**
 * Class D wiring for `first-tree github follow|unfollow|following`:
 * `/api/v1/agent/chats/:chatId/github-entities`. The follow business logic
 * lives in `github-entity-follow.test.ts`; this file locks the route layer —
 * participant gating, (human, delegate) pair resolution, and the
 * idempotent-unfollow HTTP contract.
 */
describe("agent github-entities routes", () => {
  const getApp = useTestApp();

  async function seedOrgAgent(app: App, orgId: string, memberId: string): Promise<string> {
    const uuid = randomUUID();
    await app.db.insert(agents).values({
      uuid,
      name: `agent-${uuid.slice(0, 8)}`,
      organizationId: orgId,
      type: "agent",
      displayName: "agent",
      inboxId: `inbox_${uuid}`,
      managerId: memberId,
      status: "active",
    });
    return uuid;
  }

  async function createChatWith(a: Awaited<ReturnType<typeof createTestAgent>>, participantIds: string[]) {
    const res = await a.request("POST", "/api/v1/agent/chats", { type: "group", participantIds });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  it("follow without an App installation is 422 with operator guidance", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { name: `gh-a-${randomUUID().slice(0, 6)}` });
    const human = a.humanAgentUuid;
    const chatId = await createChatWith(a, [human]);

    const res = await a.request("POST", `/api/v1/agent/chats/${chatId}/github-entities`, {
      entity: "acme/api#42",
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toContain("GitHub App");
  });

  it("follow in an agents-only chat still resolves a pair via the supervising human watcher", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { name: `gh-b-${randomUUID().slice(0, 6)}` });
    const peerAgent = await seedOrgAgent(app, a.organizationId, a.memberId);
    const chatId = await createChatWith(a, [peerAgent]);

    const res = await a.request("POST", `/api/v1/agent/chats/${chatId}/github-entities`, {
      entity: "acme/api#42",
    });
    // No human SPEAKER is present, but `createChat` recomputes watcher rows
    // for supervising humans and `resolveBindingPair` deliberately considers
    // all membership rows — the manager human is the natural representative.
    // Pair resolution therefore succeeds and the request proceeds to the
    // installation gate (422 here: the test org has no GitHub App), NOT the
    // 400 no-binding-pair branch.
    expect(res.statusCode).toBe(422);
  });

  it("a non-participant is rejected", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { name: `gh-d-${randomUUID().slice(0, 6)}` });
    const human = a.humanAgentUuid;
    const chatId = await createChatWith(a, [human]);

    const stranger = await createTestAgent(app, { name: `gh-e-${randomUUID().slice(0, 6)}` });
    const res = await stranger.request("POST", `/api/v1/agent/chats/${chatId}/github-entities`, {
      entity: "acme/api#42",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(403);
  });

  it("following lists the chat's wired entities; unfollow is idempotent over HTTP", async () => {
    const app = getApp();
    const a = await createTestAgent(app, { name: `gh-f-${randomUUID().slice(0, 6)}` });
    const human = a.humanAgentUuid;
    const chatId = await createChatWith(a, [human]);

    await app.db.insert(githubEntityChatMappings).values({
      organizationId: a.organizationId,
      humanAgentId: human,
      delegateAgentId: a.agent.uuid,
      entityType: "pull_request",
      entityKey: "Acme/Api#42",
      chatId,
      boundVia: "agent_declared",
    });

    const list = await a.request("GET", `/api/v1/agent/chats/${chatId}/github-entities`);
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: Array<{ entityKey: string; boundVia: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ entityKey: "Acme/Api#42", boundVia: "agent_declared" });

    const del = await a.request(
      "DELETE",
      `/api/v1/agent/chats/${chatId}/github-entities?entity=${encodeURIComponent("acme/api#42")}`,
    );
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ removed: 1 });

    const again = await a.request(
      "DELETE",
      `/api/v1/agent/chats/${chatId}/github-entities?entity=${encodeURIComponent("acme/api#42")}`,
    );
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ removed: 0 });
  });
});
