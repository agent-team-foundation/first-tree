import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { agents } from "../db/schema/agents.js";
import { createAgent, createToken } from "../services/agent.js";

/**
 * E2E: GitHub webhook → Server routes message → Agent pulls via SDK-equivalent fetch calls.
 *
 * This test uses the local docker-compose PG (DATABASE_URL env) instead of testcontainers,
 * to avoid Docker registry connectivity issues.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://firsttreehub:firsttreehub@localhost:5432/firsttreehub";

// SDK-equivalent helpers (same HTTP calls the CLI makes)
async function sdkRequest<T>(baseUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...Object.fromEntries(Object.entries(init?.headers ?? {})),
  };
  // Only set Content-Type for requests that have a body
  if (init?.body) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function sdkRegister(baseUrl: string, token: string) {
  return sdkRequest<{ uuid: string; inboxId: string; status: string }>(baseUrl, token, "/api/v1/agent/me");
}

function sdkPull(baseUrl: string, token: string, limit = 10) {
  return sdkRequest<Array<{ id: number; message: Record<string, unknown> }>>(
    baseUrl,
    token,
    `/api/v1/agent/inbox?limit=${limit}`,
  );
}

function sdkAck(baseUrl: string, token: string, entryId: number) {
  return sdkRequest<void>(baseUrl, token, `/api/v1/agent/inbox/${entryId}/ack`, { method: "POST" });
}

// Helper: create agent + token directly via admin-like DB operations
async function createTestAgent(
  app: Awaited<ReturnType<typeof buildApp>>,
  opts: { name: string; displayName?: string },
) {
  const agent = await createAgent(app.db, {
    name: opts.name,
    type: "autonomous_agent",
    displayName: opts.displayName ?? "Test Agent",
  });
  const tokenResult = await createToken(app.db, agent.uuid, { name: "test" });
  return { agent, token: tokenResult.token };
}

const WEBHOOK_SECRET = "test-webhook-secret-e2e";

/** Sign a payload with the test webhook secret for GitHub webhook requests. */
function signPayload(body: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
}

describe("E2E: GitHub issue → Server → CLI pull", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let address: string;

  beforeAll(async () => {
    app = await buildApp({
      database: { url: DATABASE_URL, provider: "external" },
      server: { port: 0, host: "127.0.0.1" },
      secrets: { jwtSecret: "test-jwt-secret-key-for-e2e", encryptionKey: "0".repeat(64) },
      github: { token: undefined, webhookSecret: WEBHOOK_SECRET, allowedOrg: "test-org" },
      rateLimit: { max: 10000, loginMax: 10000, webhookMax: 10000 },
      logger: false,
      instanceId: "e2e-test",
    });
    await app.ready();
    address = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(async () => {
    await app.db.execute(sql`
      TRUNCATE TABLE inbox_entries, messages, chat_participants, chats,
        agent_tokens, agent_presence, agents, admin_users, system_configs,
        server_instances CASCADE
    `);
  });

  it("full flow: webhook → inbox → pull → ack", async () => {
    // 1. Create target agent with github.repos metadata
    const { agent, token } = await createTestAgent(app, {
      name: "issue-handler",
      displayName: "Issue Handler",
    });

    await app.db
      .update(agents)
      .set({ metadata: { github: { repos: ["acme/my-repo"] } } })
      .where(eq(agents.uuid, agent.uuid));

    // 2. Send GitHub issue webhook
    const issuePayload = JSON.stringify({
      action: "opened",
      issue: {
        number: 42,
        title: "Login page broken on mobile",
        body: "Steps to reproduce:\n1. Open on iPhone\n2. Blank page",
        html_url: "https://github.com/acme/my-repo/issues/42",
        labels: [{ name: "bug" }, { name: "priority:high" }],
        state: "open",
      },
      repository: { full_name: "acme/my-repo" },
      sender: { login: "alice" },
    });
    const webhookRes = await fetch(`${address}/api/v1/webhooks/github`, {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "content-type": "application/json",
        "x-hub-signature-256": signPayload(issuePayload),
      },
      body: issuePayload,
    });

    expect(webhookRes.status).toBe(200);
    const webhookBody = (await webhookRes.json()) as Record<string, unknown>;
    expect(webhookBody.ok).toBe(true);
    expect(webhookBody.routed).toBe(true);

    // 3. Register — verify agent identity
    const identity = await sdkRegister(address, token);
    expect(identity.uuid).toBe(agent.uuid);
    expect(identity.inboxId).toBe(agent.inboxId);

    // 4. Pull — should have the GitHub issue message
    const entries = await sdkPull(address, token, 10);
    expect(entries.length).toBe(1);

    const entry = entries[0];
    if (!entry) throw new Error("Expected entry");

    expect(entry.message.format).toBe("card");
    // senderId is the github-adapter agent's UUID (auto-generated)
    expect(entry.message.senderId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);

    const content = entry.message.content as Record<string, unknown>;
    expect(content.type).toBe("github_issue");
    expect(content.action).toBe("opened");

    const issue = content.issue as Record<string, unknown>;
    expect(issue.number).toBe(42);
    expect(issue.title).toBe("Login page broken on mobile");
    expect(issue.url).toBe("https://github.com/acme/my-repo/issues/42");
    expect(issue.labels).toEqual(["bug", "priority:high"]);
    expect(content.repository).toBe("acme/my-repo");
    expect(content.sender).toBe("alice");

    const metadata = entry.message.metadata as Record<string, unknown>;
    expect(metadata.source).toBe("github");
    expect(metadata.event).toBe("issues");

    // 5. ACK
    await sdkAck(address, token, entry.id);

    // 6. Pull again — empty
    const entries2 = await sdkPull(address, token, 10);
    expect(entries2.length).toBe(0);
  });

  it("webhook signature verification", async () => {
    // Uses the shared WEBHOOK_SECRET set in beforeAll
    const payload = JSON.stringify({
      action: "opened",
      issue: { number: 1, title: "Test", body: null, html_url: "", labels: [], state: "open" },
      repository: { full_name: "acme/test" },
      sender: { login: "bob" },
    });

    // No signature → 401
    const noSig = await fetch(`${address}/api/v1/webhooks/github`, {
      method: "POST",
      headers: { "x-github-event": "issues", "content-type": "application/json" },
      body: payload,
    });
    expect(noSig.status).toBe(401);

    // Wrong signature → 401
    const wrongSig = await fetch(`${address}/api/v1/webhooks/github`, {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=wrong",
      },
      body: payload,
    });
    expect(wrongSig.status).toBe(401);

    // Correct signature → 200
    const ok = await fetch(`${address}/api/v1/webhooks/github`, {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "content-type": "application/json",
        "x-hub-signature-256": signPayload(payload),
      },
      body: payload,
    });
    expect(ok.status).toBe(200);
  });

  it("ping event", async () => {
    const pingPayload = JSON.stringify({ zen: "Anything added dilutes everything else." });
    const res = await fetch(`${address}/api/v1/webhooks/github`, {
      method: "POST",
      headers: {
        "x-github-event": "ping",
        "content-type": "application/json",
        "x-hub-signature-256": signPayload(pingPayload),
      },
      body: pingPayload,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.event).toBe("ping");
  });

  it("issue_comment event", async () => {
    const { agent, token } = await createTestAgent(app, { name: "comment-handler" });
    await app.db
      .update(agents)
      .set({ metadata: { github: { repos: ["acme/repo"] } } })
      .where(eq(agents.uuid, agent.uuid));

    const commentPayload = JSON.stringify({
      action: "created",
      issue: {
        number: 7,
        title: "Feature request",
        body: "Add dark mode",
        html_url: "https://github.com/acme/repo/issues/7",
        labels: [{ name: "enhancement" }],
        state: "open",
      },
      comment: {
        body: "I'd love this feature too! +1",
        html_url: "https://github.com/acme/repo/issues/7#issuecomment-123",
        user: { login: "charlie" },
      },
      repository: { full_name: "acme/repo" },
      sender: { login: "charlie" },
    });
    const res = await fetch(`${address}/api/v1/webhooks/github`, {
      method: "POST",
      headers: {
        "x-github-event": "issue_comment",
        "content-type": "application/json",
        "x-hub-signature-256": signPayload(commentPayload),
      },
      body: commentPayload,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).routed).toBe(true);

    // Pull
    const entries = await sdkPull(address, token, 10);
    expect(entries.length).toBe(1);

    const content = entries[0]?.message.content as Record<string, unknown>;
    expect(content.type).toBe("github_issue_comment");
    const comment = content.comment as Record<string, unknown>;
    expect(comment.body).toBe("I'd love this feature too! +1");
    expect(comment.author).toBe("charlie");
  });
});
