import { randomBytes } from "node:crypto";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CurrentRunHandle, readCredentialsOrThrow, readCurrentHandle } from "../framework/current-handle.js";
import { type GitHubMock, startGithubMock } from "../framework/github-mock.js";
import { authedJson } from "../framework/server-driver/http.js";

/**
 * GitHub PR **secondary** events e2e — proves that comments + reviews on
 * an already-bound PR route to the same chat instead of forking a new one.
 *
 *   - `github-pr-delivery.e2e.test.ts` covers the *fresh-chat* path
 *     (`pull_request.opened`) and `synchronize` reuse.
 *   - This file covers the three event kinds that dominate day-to-day
 *     PR collaboration: `issue_comment`, `pull_request_review`,
 *     `pull_request_review_comment` — each must resolve through the
 *     same `services/github-entity-chat.ts:resolveTargetChat` lookup
 *     and land a card in the **pre-existing** chat (`newChats === 0`,
 *     card row appended).
 *
 * Setup mirrors github-pr-delivery: emit `installation.created`, bind
 * the installation to the e2e org via the one direct PG write, create a
 * delegate autonomous agent, set the human's `delegateMention`, then
 * drive a `pull_request.opened` with the human as assignee to *seed*
 * the entity binding. Every test then sends a follow-up event and
 * asserts it reused the seeded chat.
 *
 * The github-mock's `/api/*` 404 surface stays unused — none of these
 * deliveries call out to api.github.com.
 *
 * Requires `E2E_WITH_CLIENT=1`.
 */

const INSTALLATION_ID = 100_000 + Math.floor(Math.random() * 9_000_000);
const PR_NUMBER = 73;
const REPO = `e2e-org/e2e-secondary-${randomBytes(2).toString("hex")}`;
const ENTITY_KEY = `${REPO}#${PR_NUMBER}`;

let handle: CurrentRunHandle;
let mock: GitHubMock;
let delegateAgentId: string;
let humanLogin: string;
let chatId: string;
let cardCountAfterSeed = 0;

beforeAll(async () => {
  handle = readCurrentHandle();
  const creds = readCredentialsOrThrow(handle);
  humanLogin = creds.humanAgentName;

  mock = await startGithubMock({
    serverBaseUrl: handle.serverBaseUrl,
    webhookSecret: handle.githubWebhookSecret,
  });

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
      events: ["pull_request", "issues", "issue_comment", "pull_request_review"],
      suspended_at: null,
    },
  });
  expect(install.status).toBe(200);

  const pg = new PgClient({ connectionString: handle.databaseUrl });
  await pg.connect();
  try {
    // `uq_github_app_installations_hub_org` forbids two installations
    // bound to the same org. Earlier tests in the suite (e.g.
    // github-pr-delivery) may have already claimed the e2e org for a
    // different installation_id; release that binding before claiming
    // ours so the UPDATE below doesn't violate the unique constraint.
    await pg.query(
      "UPDATE github_app_installations SET hub_organization_id = NULL WHERE hub_organization_id = $1 AND installation_id <> $2",
      [creds.organizationId, INSTALLATION_ID],
    );
    await pg.query("UPDATE github_app_installations SET hub_organization_id = $1 WHERE installation_id = $2", [
      creds.organizationId,
      INSTALLATION_ID,
    ]);
  } finally {
    await pg.end();
  }

  delegateAgentId = (
    await authedJson<{ uuid: string }>(
      handle.serverBaseUrl,
      creds.accessToken,
      "POST",
      `/api/v1/orgs/${encodeURIComponent(creds.organizationId)}/agents`,
      {
        name: `e2e-prsec-delegate-${randomBytes(2).toString("hex")}`,
        type: "agent",
        displayName: "E2E PR Secondary Delegate",
        clientId: creds.clientId,
      },
      201,
    )
  ).uuid;

  await authedJson(
    handle.serverBaseUrl,
    creds.accessToken,
    "PATCH",
    `/api/v1/agents/${encodeURIComponent(creds.humanAgentId)}`,
    { delegateMention: delegateAgentId },
    200,
  );

  // Seed the binding with a fresh-chat `pull_request.opened` so the rest
  // of the file tests reuse — not creation.
  const seedRes = await mock.emit("pull_request", {
    action: "opened",
    installation: { id: INSTALLATION_ID },
    sender: { login: "external-actor", type: "User" },
    repository: { full_name: REPO },
    pull_request: {
      number: PR_NUMBER,
      title: "feat: secondary-events seed",
      body: "",
      html_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
      assignees: [{ login: humanLogin }],
      requested_reviewers: [],
    },
  });
  expect(seedRes.status).toBe(200);
  const seedBody = seedRes.body as { newChats?: number };
  if (seedBody.newChats !== 1) {
    throw new Error(`seed: expected newChats=1, got ${seedBody.newChats}; body=${JSON.stringify(seedBody)}`);
  }

  const pg2 = new PgClient({ connectionString: handle.databaseUrl });
  await pg2.connect();
  try {
    const mapping = await pg2.query<{ chat_id: string }>(
      `SELECT chat_id FROM github_entity_chat_mappings
       WHERE organization_id = $1 AND entity_type = 'pull_request' AND entity_key = $2`,
      [creds.organizationId, ENTITY_KEY],
    );
    const seeded = mapping.rows[0]?.chat_id;
    if (!seeded) throw new Error("seed: github_entity_chat_mappings row missing after opened");
    chatId = seeded;
    const cards = await pg2.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM messages WHERE chat_id = $1 AND format = 'card'",
      [chatId],
    );
    cardCountAfterSeed = Number(cards.rows[0]?.n ?? "0");
    expect(cardCountAfterSeed).toBeGreaterThanOrEqual(1);
  } finally {
    await pg2.end();
  }
});

afterAll(async () => {
  await mock.stop();
});

async function countCards(): Promise<number> {
  const pg = new PgClient({ connectionString: handle.databaseUrl });
  await pg.connect();
  try {
    const cards = await pg.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM messages WHERE chat_id = $1 AND format = 'card'",
      [chatId],
    );
    return Number(cards.rows[0]?.n ?? "0");
  } finally {
    await pg.end();
  }
}

function commonEnvelope() {
  return {
    installation: { id: INSTALLATION_ID },
    sender: { login: "external-actor", type: "User" },
    repository: { full_name: REPO },
  };
}

function prShape() {
  return {
    number: PR_NUMBER,
    title: "feat: secondary-events seed",
    body: "",
    html_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
  };
}

describe("github PR secondary events — route to pre-existing bound chat", () => {
  it("issue_comment.created on the bound PR reuses the chat and appends a card", async () => {
    const before = await countCards();
    const res = await mock.emit("issue_comment", {
      action: "created",
      ...commonEnvelope(),
      issue: {
        number: PR_NUMBER,
        title: prShape().title,
        body: "",
        html_url: `https://github.com/${REPO}/issues/${PR_NUMBER}`,
        // The `issue.pull_request` key is what makes GitHub's webhook split
        // PR-comments off from issue-comments — `extractEventEntity` keys on
        // it to resolve `entity.type = "pull_request"`. Without this we'd
        // accidentally bind to an `issue` entity_key and miss the mapping.
        pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/${PR_NUMBER}` },
      },
      comment: {
        body: `looking good @${humanLogin}`,
        html_url: `https://github.com/${REPO}/pull/${PR_NUMBER}#issuecomment-123`,
      },
    });
    expect(res.status).toBe(200);
    const body = res.body as { delivered?: number; newChats?: number };
    expect(body.delivered).toBeGreaterThanOrEqual(1);
    expect(body.newChats).toBe(0);

    expect(await countCards()).toBe(before + 1);
  });

  it("pull_request_review.submitted on the bound PR reuses the chat and appends a card", async () => {
    const before = await countCards();
    const res = await mock.emit("pull_request_review", {
      action: "submitted",
      ...commonEnvelope(),
      pull_request: prShape(),
      review: {
        body: `nit: rename @${humanLogin}`,
        html_url: `https://github.com/${REPO}/pull/${PR_NUMBER}#pullrequestreview-456`,
        state: "commented",
      },
    });
    expect(res.status).toBe(200);
    const body = res.body as { delivered?: number; newChats?: number };
    expect(body.delivered).toBeGreaterThanOrEqual(1);
    expect(body.newChats).toBe(0);

    expect(await countCards()).toBe(before + 1);
  });

  it("pull_request_review_comment.created on the bound PR reuses the chat and appends a card", async () => {
    const before = await countCards();
    const res = await mock.emit("pull_request_review_comment", {
      action: "created",
      ...commonEnvelope(),
      pull_request: prShape(),
      comment: {
        body: `inline question for @${humanLogin}`,
        html_url: `https://github.com/${REPO}/pull/${PR_NUMBER}#discussion_r789`,
      },
    });
    expect(res.status).toBe(200);
    const body = res.body as { delivered?: number; newChats?: number };
    expect(body.delivered).toBeGreaterThanOrEqual(1);
    expect(body.newChats).toBe(0);

    expect(await countCards()).toBe(before + 1);
  });
});
