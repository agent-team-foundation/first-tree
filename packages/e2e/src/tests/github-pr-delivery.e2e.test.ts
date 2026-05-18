import { randomBytes } from "node:crypto";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CurrentRunHandle, readCredentialsOrThrow, readCurrentHandle } from "../framework/current-handle.js";
import { type GitHubMock, startGithubMock } from "../framework/github-mock.js";

/**
 * GitHub PR delivery e2e — exercises the **full** server-side Stage 1→2→3
 * pipeline:
 *
 *   1. Stage 0 — pre-flight: install the App (via `installation.created`
 *      webhook, already covered by github-webhook.e2e), then bind that
 *      installation to the e2e org by setting `hub_organization_id` on the
 *      installation row directly (real life: a human clicks the App-install
 *      flow + the OAuth callback writes this column; the OAuth callback
 *      route isn't reachable from e2e without seeding the same SQL).
 *   2. Stage 0.5 — seed a subscription row in `github_entity_chat_mappings`
 *      so the audience resolver finds a target without us needing to wire
 *      mention/delegate config. This is Path A from the audience contract
 *      (see `packages/server/src/services/github-audience.ts`).
 *   3. Stage 1–3 — drive a `pull_request.synchronize` webhook for that
 *      entity. The server normalises, claims, resolves audience to
 *      `[{kind: "existing", chatId}]`, and writes a `format: "card"`
 *      message into the bound chat via `deliverNormalizedEvent`.
 *
 * Side-effect assertions land on:
 *   - the webhook response stats `{ delivered, newChats }`,
 *   - the `messages` table in PG for the bound chat (a card with the
 *     expected entity_key in metadata).
 *
 * No outbound api.github.com call happens during this delivery path
 * (confirmed by tracing `services/github-app.ts` and
 * `services/github-delivery.ts` — installation token mint + entity-live
 * fetch only run on the OAuth-callback + chat-sidebar surfaces, not on
 * the webhook pipeline). The `github-mock.fastify` `/api/*` 404 surface
 * therefore stays unused for this test — but is ready for future tests
 * that exercise the sidebar live state.
 *
 * Requires `E2E_WITH_CLIENT=1` so we have a human agent + access token to
 * call the public chat / agent creation API.
 */

const INSTALLATION_ID = 9_876_543; // deliberately unique per test file, avoids `installation_id` UNIQUE collisions

let handle: CurrentRunHandle;
let mock: GitHubMock;
let testAgentId: string;
let chatId: string;

const REPO = `e2e-org/e2e-repo-${randomBytes(2).toString("hex")}`;
const PR_NUMBER = 42;
const ENTITY_KEY = `${REPO}#${PR_NUMBER}`;

beforeAll(async () => {
  handle = readCurrentHandle();
  const creds = readCredentialsOrThrow(handle);
  mock = await startGithubMock({
    serverBaseUrl: handle.serverBaseUrl,
    webhookSecret: handle.githubWebhookSecret,
  });

  // 1. Drive installation.created so the server has a installation row to
  //    look up. The webhook leaves hub_organization_id NULL (binding is the
  //    OAuth callback's job in prod).
  const install = await mock.emit("installation", {
    action: "created",
    installation: {
      id: INSTALLATION_ID,
      account: {
        id: 50_000 + Math.floor(Math.random() * 50_000),
        login: `e2e-acct-${INSTALLATION_ID}`,
        type: "Organization",
      },
      permissions: { contents: "write", pull_requests: "write", issues: "read" },
      events: ["pull_request", "issues"],
      suspended_at: null,
    },
  });
  expect(install.status).toBe(200);

  const pg = new PgClient({ connectionString: handle.databaseUrl });
  await pg.connect();
  try {
    // 2. Bind installation → e2e org (the column the OAuth callback would
    //    set in prod). Without this the webhook handler short-circuits with
    //    "installation not bound" at line ~191 of webhooks/github-app.ts.
    await pg.query("UPDATE github_app_installations SET hub_organization_id = $1 WHERE installation_id = $2", [
      creds.organizationId,
      INSTALLATION_ID,
    ]);

    // 3. Create a second autonomous agent to act as the "delegate" side of
    //    the mapping. The mapping primary key includes (human, delegate,
    //    entity) so we need two distinct agent uuids — humanAgent is the
    //    e2e user's human agent (provisioned by credentials helper),
    //    delegate is a fresh autonomous one we create via the public API.
    const agentRes = await fetch(`${handle.serverBaseUrl}/api/v1/orgs/${creds.organizationId}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.accessToken}` },
      body: JSON.stringify({
        name: `e2e-gh-bot-${randomBytes(3).toString("hex")}`,
        type: "autonomous_agent",
        displayName: "E2E GitHub Delegate",
        clientId: creds.clientId,
      }),
    });
    if (agentRes.status !== 201) {
      throw new Error(`failed to create delegate agent: ${agentRes.status} ${await agentRes.text()}`);
    }
    const agentBody = (await agentRes.json()) as { uuid: string };
    testAgentId = agentBody.uuid;

    // 4. Create the chat that the binding will point at. Goes through the
    //    public POST /orgs/:orgId/chats — same as the messaging test, same
    //    invariants exercised.
    const chatRes = await fetch(`${handle.serverBaseUrl}/api/v1/orgs/${creds.organizationId}/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.accessToken}` },
      body: JSON.stringify({ participantIds: [testAgentId] }),
    });
    if (chatRes.status !== 201) {
      throw new Error(`failed to create chat: ${chatRes.status} ${await chatRes.text()}`);
    }
    const chatBody = (await chatRes.json()) as { chatId: string };
    chatId = chatBody.chatId;

    // 5. Insert the entity → chat mapping. This is the Path A seed that
    //    makes `resolveAudience` return a `kind: "existing"` row.
    await pg.query(
      `INSERT INTO github_entity_chat_mappings
         (organization_id, human_agent_id, delegate_agent_id, entity_type, entity_key, chat_id, bound_via)
       VALUES ($1, $2, $3, 'pull_request', $4, $5, 'direct')`,
      [creds.organizationId, creds.humanAgentId, testAgentId, ENTITY_KEY, chatId],
    );
  } finally {
    await pg.end();
  }
});

afterAll(async () => {
  await mock.stop();
});

describe("M2.5 github PR delivery — webhook → bound chat card", () => {
  it("delivers a card message into the bound chat for pull_request.synchronize", async () => {
    const result = await mock.emit("pull_request", {
      action: "synchronize",
      installation: { id: INSTALLATION_ID },
      sender: { login: "external-actor", type: "User" },
      repository: { full_name: REPO },
      pull_request: {
        number: PR_NUMBER,
        title: "feat: e2e test PR",
        body: "",
        html_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
        assignees: [],
        requested_reviewers: [],
      },
    });
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; event: string; delivered?: number };
    expect(body.ok).toBe(true);
    expect(body.event).toBe("pull_request");
    expect(body.delivered).toBeGreaterThanOrEqual(1);

    // Confirm the card landed in the bound chat and carries the correct
    // entity_key metadata. Sender is the human agent (the mapping's human
    // side) — the server attributes incoming GitHub events to the human
    // agent that owns the subscription.
    const pg = new PgClient({ connectionString: handle.databaseUrl });
    await pg.connect();
    try {
      const rows = await pg.query<{ id: string; format: string; sender_id: string; metadata: unknown }>(
        "SELECT id, format, sender_id, metadata FROM messages WHERE chat_id = $1 ORDER BY created_at DESC",
        [chatId],
      );
      const creds = readCredentialsOrThrow(handle);
      const card = rows.rows.find((r) => r.format === "card");
      expect(card, `expected at least one card message in chat ${chatId}`).toBeDefined();
      if (!card) return;
      expect(card.sender_id).toBe(creds.humanAgentId);
      // Card metadata is flat (see `services/github-delivery.ts:69`):
      //   { source, event, action, entityType, entityKey, reason, [mentionedUser] }
      const md = card.metadata as {
        source?: string;
        event?: string;
        entityType?: string;
        entityKey?: string;
      } | null;
      expect(md?.source).toBe("github");
      expect(md?.event).toBe("pull_request");
      expect(md?.entityType).toBe("pull_request");
      expect(md?.entityKey).toBe(ENTITY_KEY);
    } finally {
      await pg.end();
    }
  });

  it("dedupes a redelivery with the same X-GitHub-Delivery id", async () => {
    const deliveryId = globalThis.crypto.randomUUID();
    const payload = {
      action: "synchronize",
      installation: { id: INSTALLATION_ID },
      sender: { login: "external-actor", type: "User" },
      repository: { full_name: REPO },
      pull_request: {
        number: PR_NUMBER,
        title: "feat: redelivered",
        body: "",
        html_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
        assignees: [],
        requested_reviewers: [],
      },
    };

    const first = await mock.emit("pull_request", payload, { deliveryId });
    expect(first.status).toBe(200);
    const firstBody = first.body as { delivered?: number; deduped?: boolean };
    expect(firstBody.delivered).toBeGreaterThanOrEqual(1);

    const second = await mock.emit("pull_request", payload, { deliveryId });
    expect(second.status).toBe(200);
    const secondBody = second.body as { delivered?: number; deduped?: boolean };
    expect(secondBody.deduped).toBe(true);
  });
});
