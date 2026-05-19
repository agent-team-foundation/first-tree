import { randomBytes } from "node:crypto";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CurrentRunHandle, readCredentialsOrThrow, readCurrentHandle } from "../framework/current-handle.js";
import { mintDevUserTokens } from "../framework/server-driver/dev-callback.js";
import { authedFetch, authedJson } from "../framework/server-driver/http.js";

/**
 * Client claim e2e — covers the cross-user `client.user_id` transfer path
 * (`POST /api/v1/clients/:clientId/claim`). The fixture user owns one client
 * (planted by `credentials.ts`); a second user signs in via dev-callback,
 * claims that client, and we assert that:
 *
 *   1. The HTTP response reports the previous owner correctly.
 *   2. `clients.user_id` in PG now points at the new owner.
 *   3. Any agent that was pinned to the client gets unpinned (`agents.client_id`
 *      reset to NULL), which is how the unified-user-token milestone enforces
 *      the "switching user releases bound agents" rule.
 *
 * Why PG side-effect asserts: the public API response only echoes counts
 * (`unpinnedAgentCount`) without giving the new ownership state on the
 * client row itself. The architecture rule "switching user requires
 * `client claim --confirm` which atomically transfers" is the durable
 * contract; we pin both the row update AND the agent unpin from the same
 * service call.
 *
 * Requires `E2E_WITH_CLIENT=1` so globalSetup provisioned credentials, AND
 * `FIRST_TREE_HUB_DEV_CALLBACK_ENABLED=1` on the server (globalSetup turns
 * this on for all e2e runs).
 */

let handle: CurrentRunHandle;
let pg: PgClient;
let originalAgentId: string;
let userBAccessToken: string;
let userBId: string;

beforeAll(async () => {
  handle = readCurrentHandle();
  const creds = readCredentialsOrThrow(handle);

  // Pin an autonomous agent to the fixture client so we can assert that the
  // claim's "unpin previous-owner agents" effect actually fires.
  const created = await authedJson<{ uuid: string }>(
    handle.serverBaseUrl,
    creds.accessToken,
    "POST",
    `/api/v1/orgs/${encodeURIComponent(creds.organizationId)}/agents`,
    {
      name: `e2e-claim-${randomBytes(3).toString("hex")}`,
      type: "autonomous_agent",
      displayName: "Pre-claim pinned agent",
      clientId: creds.clientId,
    },
    201,
  );
  originalAgentId = created.uuid;

  // dev-callback mints a fresh user; we pick `githubId=2, login=claimer-…`
  // so we don't collide with the dev-user seed (githubId=1, login=devuser)
  // when it's enabled by `pnpm e2e:up`.
  const claimer = await mintDevUserTokens({
    serverBaseUrl: handle.serverBaseUrl,
    githubId: 2,
    login: `claimer-${randomBytes(3).toString("hex")}`,
    displayName: "Claim Target User",
  });
  userBAccessToken = claimer.accessToken;

  pg = new PgClient({ connectionString: handle.databaseUrl });
  await pg.connect();
  const me = await pg.query<{ id: string }>(
    "SELECT id FROM users WHERE username LIKE 'claimer-%' ORDER BY created_at DESC LIMIT 1",
  );
  if (!me.rows[0]) throw new Error("claim-test user B never appeared in PG after dev-callback");
  userBId = me.rows[0].id;
});

afterAll(async () => {
  await pg.end().catch(() => undefined);
});

describe("client claim — POST /clients/:clientId/claim transfers ownership", () => {
  it("response echoes previousUserId; PG row flips to new owner; pinned agent gets unpinned", async () => {
    const creds = readCredentialsOrThrow(handle);

    // Sanity-check pre-state via PG so the assertion failure (if any) tells
    // the next reader what we expected. The fixture user owns `creds.clientId`
    // and our test agent is pinned to it.
    const preClient = await pg.query<{ user_id: string }>("SELECT user_id FROM clients WHERE id = $1", [
      creds.clientId,
    ]);
    expect(preClient.rows[0]?.user_id).toBe(creds.userId);
    const preAgent = await pg.query<{ client_id: string | null }>("SELECT client_id FROM agents WHERE uuid = $1", [
      originalAgentId,
    ]);
    expect(preAgent.rows[0]?.client_id).toBe(creds.clientId);

    // Claim with user B's bearer.
    const claimRes = await authedJson<{ clientId: string; previousUserId: string; unpinnedAgentCount: number }>(
      handle.serverBaseUrl,
      userBAccessToken,
      "POST",
      `/api/v1/clients/${encodeURIComponent(creds.clientId)}/claim`,
      {},
      200,
    );
    expect(claimRes.clientId).toBe(creds.clientId);
    expect(claimRes.previousUserId).toBe(creds.userId);
    // The agent we pinned in beforeAll is one of the unpins; the fixture's
    // own human agent is unmanaged-by-client so it isn't unpinned. Strict
    // equality (=== 1) would over-fit; assert at least our agent counted.
    expect(claimRes.unpinnedAgentCount).toBeGreaterThanOrEqual(1);

    const postClient = await pg.query<{ user_id: string }>("SELECT user_id FROM clients WHERE id = $1", [
      creds.clientId,
    ]);
    expect(postClient.rows[0]?.user_id).toBe(userBId);

    const postAgent = await pg.query<{ client_id: string | null }>("SELECT client_id FROM agents WHERE uuid = $1", [
      originalAgentId,
    ]);
    expect(postAgent.rows[0]?.client_id).toBeNull();
  });

  it("a second claim by the same user is a no-op (same owner, zero unpins)", async () => {
    const creds = readCredentialsOrThrow(handle);
    const res = await authedFetch(
      handle.serverBaseUrl,
      userBAccessToken,
      "POST",
      `/api/v1/clients/${encodeURIComponent(creds.clientId)}/claim`,
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clientId: string; previousUserId: string; unpinnedAgentCount: number };
    expect(body.previousUserId).toBe(userBId);
    expect(body.unpinnedAgentCount).toBe(0);
  });
});
