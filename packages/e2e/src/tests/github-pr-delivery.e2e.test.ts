import { randomBytes, randomUUID } from "node:crypto";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CurrentRunHandle, readCredentialsOrThrow, readCurrentHandle } from "../framework/current-handle.js";
import { type GitHubMock, startGithubMock } from "../framework/github-mock.js";

/**
 * GitHub PR delivery e2e — exercises the **full** server-side Stage 1→2→3
 * pipeline, including the fresh-chat creation branch that a raw
 * subscription INSERT would skip.
 *
 *   Setup (`beforeAll`):
 *     1. Drive `installation.created` via github-mock — installation row UPSERT.
 *     2. UPDATE `github_app_installations.hub_organization_id` to bind the
 *        install to the e2e org. This is the ONE direct PG write that
 *        survives the review's "minimise raw SQL" mandate — the prod
 *        equivalent is the OAuth callback, which we'd need to seed an
 *        `auth_identities` row + stub api.github.com `/user/memberships`
 *        to drive headlessly. Out of scope for this test.
 *     3. Create the *delegate* autonomous agent via the public
 *        `POST /orgs/:orgId/agents` API. The credentials helper's human
 *        agent serves as the *candidate* (the side that receives the PR
 *        mention) — `delegateMention` is server-restricted to human
 *        agents, so we can't put it on an autonomous one.
 *     4. PATCH the human agent's `delegateMention = delegate.uuid` via
 *        the public agent update API. The audience resolver filters
 *        candidates by `isNotNull(delegateMention)` (see
 *        `services/github-audience.ts:158-168`).
 *
 *   Tests:
 *     - `pull_request.opened` with `assignees: [{login: humanAgentName}]`
 *       → server creates a fresh chat + mapping (Path C `createEntityChat`
 *       in `services/github-entity-chat.ts`) and delivers a card. Asserts
 *       `newChats === 1`, mapping row materialised, single card with the
 *       right metadata.
 *     - `pull_request.synchronize` for the same entity → audience
 *       resolves to `kind: "existing"` via the just-created mapping.
 *       Reuses the chat (`newChats === 0`), adds a second card.
 *     - Redelivery with the same `X-GitHub-Delivery` id → 200 deduped, no
 *       extra card.
 *
 * No outbound api.github.com call happens during this delivery path —
 * confirmed by tracing `services/github-app.ts` + `services/github-
 * delivery.ts`. The `github-mock.fastify` `/api/*` 404 surface stays
 * unused (kept available for the future sidebar-live-state e2e).
 *
 * Requires `E2E_WITH_CLIENT=1` so we have a human agent + access token to
 * call the public chat / agent creation API.
 */

const INSTALLATION_ID = 100_000 + Math.floor(Math.random() * 9_000_000); // random per run; PG container is per-run so no cross-run collision
const PR_NUMBER = 42;
const REPO = `e2e-org/e2e-repo-${randomBytes(2).toString("hex")}`;
const ENTITY_KEY = `${REPO}#${PR_NUMBER}`;

const DELEGATE_NAME = `e2e-pr-delegate-${randomBytes(2).toString("hex")}`;

let handle: CurrentRunHandle;
let mock: GitHubMock;
let delegateAgentId: string;
/** Set by the `opened` test; reused by the `synchronize` + dedupe tests. */
let createdChatId: string | null = null;

beforeAll(async () => {
  handle = readCurrentHandle();
  const creds = readCredentialsOrThrow(handle);
  mock = await startGithubMock({
    serverBaseUrl: handle.serverBaseUrl,
    webhookSecret: handle.githubWebhookSecret,
  });

  // 1. installation.created
  const install = await mock.emit("installation", {
    action: "created",
    installation: {
      id: INSTALLATION_ID,
      account: {
        id: 200_000 + Math.floor(Math.random() * 800_000),
        login: `e2e-acct-${INSTALLATION_ID}`,
        type: "Organization",
      },
      permissions: { contents: "write", pull_requests: "write", issues: "read" },
      events: ["pull_request", "issues"],
      suspended_at: null,
    },
  });
  expect(install.status).toBe(200);

  // 2. Bind install to org (the only direct PG write).
  const pg = new PgClient({ connectionString: handle.databaseUrl });
  await pg.connect();
  try {
    await pg.query("UPDATE github_app_installations SET hub_organization_id = $1 WHERE installation_id = $2", [
      creds.organizationId,
      INSTALLATION_ID,
    ]);
  } finally {
    await pg.end();
  }

  // 3. Create the delegate autonomous agent via the public API. Pinned to
  //    the same e2e client (required by createAgentSchema for non-humans).
  const delegateRes = await fetch(`${handle.serverBaseUrl}/api/v1/orgs/${creds.organizationId}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.accessToken}` },
    body: JSON.stringify({
      name: DELEGATE_NAME,
      type: "autonomous_agent",
      displayName: "E2E PR Delegate",
      clientId: creds.clientId,
    }),
  });
  if (delegateRes.status !== 201) {
    throw new Error(`failed to create delegate agent: ${delegateRes.status} ${await delegateRes.text()}`);
  }
  const delegateBody = (await delegateRes.json()) as { uuid: string };
  delegateAgentId = delegateBody.uuid;

  // 4. PATCH the human agent's delegateMention. Without it the audience
  //    resolver filters the human out of the candidate set
  //    (`isNotNull(delegateMention)`).
  const patchRes = await fetch(`${handle.serverBaseUrl}/api/v1/agents/${creds.humanAgentId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.accessToken}` },
    body: JSON.stringify({ delegateMention: delegateAgentId }),
  });
  if (patchRes.status !== 200) {
    throw new Error(`failed to PATCH humanAgent.delegateMention: ${patchRes.status} ${await patchRes.text()}`);
  }
});

afterAll(async () => {
  await mock.stop();
});

function basePrPayload(
  action: "opened" | "synchronize",
  candidateLogin: string,
  overrides: { body?: string; title?: string } = {},
) {
  return {
    action,
    installation: { id: INSTALLATION_ID },
    sender: { login: "external-actor", type: "User" },
    repository: { full_name: REPO },
    pull_request: {
      number: PR_NUMBER,
      title: overrides.title ?? `feat: e2e ${action}`,
      body: overrides.body ?? "",
      html_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
      assignees: [{ login: candidateLogin }],
      requested_reviewers: [],
    },
  };
}

describe("github PR delivery — webhook → bound chat card", () => {
  it("pull_request.opened with an assigned candidate creates a fresh chat + mapping + delivers a card", async () => {
    const creds = readCredentialsOrThrow(handle);
    const result = await mock.emit("pull_request", basePrPayload("opened", creds.humanAgentName));
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; event: string; delivered?: number; newChats?: number };
    expect(body.ok).toBe(true);
    expect(body.event).toBe("pull_request");
    expect(body.delivered).toBeGreaterThanOrEqual(1);
    // newChats === 1 proves we exercised the createEntityChat path, not a
    // pre-existing mapping.
    expect(body.newChats).toBe(1);

    const pg = new PgClient({ connectionString: handle.databaseUrl });
    await pg.connect();
    try {
      // Mapping row materialised by the server.
      const mapping = await pg.query<{ chat_id: string }>(
        `SELECT chat_id FROM github_entity_chat_mappings
         WHERE organization_id = $1 AND human_agent_id = $2 AND delegate_agent_id = $3
           AND entity_type = 'pull_request' AND entity_key = $4`,
        [creds.organizationId, creds.humanAgentId, delegateAgentId, ENTITY_KEY],
      );
      expect(mapping.rows).toHaveLength(1);
      const chatId = mapping.rows[0]?.chat_id;
      expect(chatId).toBeTruthy();
      if (!chatId) return;
      createdChatId = chatId;

      // Exactly one card in the new chat, attributed to the human agent
      // (the audience resolver's `humanAgentId` for a kind:"new" row), with
      // the entity_key in flat metadata.
      const cards = await pg.query<{ format: string; sender_id: string; metadata: unknown }>(
        "SELECT format, sender_id, metadata FROM messages WHERE chat_id = $1 ORDER BY created_at",
        [chatId],
      );
      expect(cards.rows).toHaveLength(1);
      const card = cards.rows[0];
      expect(card).toBeDefined();
      if (!card) return;
      expect(card.format).toBe("card");
      expect(card.sender_id).toBe(creds.humanAgentId);
      const md = card.metadata as { source?: string; event?: string; entityType?: string; entityKey?: string } | null;
      expect(md?.source).toBe("github");
      expect(md?.event).toBe("pull_request");
      expect(md?.entityType).toBe("pull_request");
      expect(md?.entityKey).toBe(ENTITY_KEY);
    } finally {
      await pg.end();
    }
  });

  it("pull_request.synchronize for the same entity reuses the existing chat (kind:existing path)", async () => {
    if (!createdChatId) throw new Error("test ordering: 'opened' test must run first to seed the mapping");
    const creds = readCredentialsOrThrow(handle);

    const result = await mock.emit("pull_request", basePrPayload("synchronize", creds.humanAgentName));
    expect(result.status).toBe(200);
    const body = result.body as { delivered?: number; newChats?: number };
    expect(body.delivered).toBeGreaterThanOrEqual(1);
    // No fresh chat — proves we hit the kind:"existing" branch.
    expect(body.newChats).toBe(0);

    const pg = new PgClient({ connectionString: handle.databaseUrl });
    await pg.connect();
    try {
      const cards = await pg.query<{ id: string }>("SELECT id FROM messages WHERE chat_id = $1 AND format = 'card'", [
        createdChatId,
      ]);
      // Two cards now (opened + synchronize).
      expect(cards.rows.length).toBeGreaterThanOrEqual(2);
    } finally {
      await pg.end();
    }
  });

  it("redelivery of the same X-GitHub-Delivery id is deduped and writes no extra card", async () => {
    if (!createdChatId) throw new Error("test ordering: 'opened' test must run first");
    const creds = readCredentialsOrThrow(handle);

    const deliveryId = randomUUID();
    const payload = basePrPayload("synchronize", creds.humanAgentName, { title: "feat: redelivered" });

    const pg = new PgClient({ connectionString: handle.databaseUrl });
    await pg.connect();
    let cardCountBefore: number;
    try {
      const r = await pg.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM messages WHERE chat_id = $1 AND format = 'card'",
        [createdChatId],
      );
      cardCountBefore = Number(r.rows[0]?.n ?? "0");
    } finally {
      await pg.end();
    }

    const first = await mock.emit("pull_request", payload, { deliveryId });
    expect(first.status).toBe(200);
    expect((first.body as { delivered?: number }).delivered).toBeGreaterThanOrEqual(1);

    const second = await mock.emit("pull_request", payload, { deliveryId });
    expect(second.status).toBe(200);
    expect((second.body as { deduped?: boolean }).deduped).toBe(true);

    const pg2 = new PgClient({ connectionString: handle.databaseUrl });
    await pg2.connect();
    try {
      const r = await pg2.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM messages WHERE chat_id = $1 AND format = 'card'",
        [createdChatId],
      );
      const cardCountAfter = Number(r.rows[0]?.n ?? "0");
      // First call delivered 1 more card; second call deduped → still +1, not +2.
      expect(cardCountAfter).toBe(cardCountBefore + 1);
    } finally {
      await pg2.end();
    }
  });
});
