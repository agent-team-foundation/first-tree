import { randomBytes } from "node:crypto";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CurrentRunHandle, readCredentialsOrThrow, readCurrentHandle } from "../framework/current-handle.js";
import { authedFetch, authedJson } from "../framework/server-driver/http.js";

/**
 * Agent lifecycle e2e — exercises the management surface a `manage`-scoped
 * caller (fixture user is admin in `default`) drives on an autonomous agent:
 *
 *   POST   /api/v1/orgs/:orgId/agents      — create
 *   GET    /api/v1/agents/:uuid            — read after create
 *   PATCH  /api/v1/agents/:uuid            — mutate displayName + delegate
 *   POST   /api/v1/agents/:uuid/suspend    — flip status active → suspended
 *   POST   /api/v1/agents/:uuid/reactivate — flip back suspended → active
 *   DELETE /api/v1/agents/:uuid            — tombstone
 *
 * PG side effects assertions confirm the `agents.status` column and the row
 * removal land where the API says they do. The `status` field isn't surfaced
 * on the response body shape we depend on today, so PG is the only way to
 * pin the suspend / reactivate contract without growing a server schema
 * dependency in the e2e package.
 *
 * Requires `E2E_WITH_CLIENT=1` so globalSetup provisioned credentials.
 */

let handle: CurrentRunHandle;
let agentId: string;
let pg: PgClient | null = null;

beforeAll(async () => {
  handle = readCurrentHandle();
  const creds = readCredentialsOrThrow(handle);

  // Use a suite-owned client row instead of the shared fixture client. Other
  // e2e suites intentionally mutate ownership of `creds.clientId` (client
  // claim), so reusing it here makes this suite order-dependent.
  const lifecycleClientId = `client_life_${randomBytes(4).toString("hex")}`;
  pg = new PgClient({ connectionString: handle.databaseUrl });
  await pg.connect();
  await pg.query("INSERT INTO clients (id, user_id, organization_id) VALUES ($1, $2, $3)", [
    lifecycleClientId,
    creds.userId,
    creds.organizationId,
  ]);

  const created = await authedJson<{ uuid: string; displayName: string }>(
    handle.serverBaseUrl,
    creds.accessToken,
    "POST",
    `/api/v1/orgs/${encodeURIComponent(creds.organizationId)}/agents`,
    {
      name: `e2e-life-${randomBytes(3).toString("hex")}`,
      type: "agent",
      displayName: "Lifecycle target",
      clientId: lifecycleClientId,
    },
    201,
  );
  agentId = created.uuid;
});

afterAll(async () => {
  const client = pg;
  if (client) {
    await client.end().catch(() => undefined);
  }
});

async function readAgentStatus(uuid: string): Promise<string | null> {
  const client = pg;
  if (!client) {
    throw new Error("PG client was not initialized before reading agent status");
  }
  const res = await client.query<{ status: string | null }>("SELECT status FROM agents WHERE uuid = $1 LIMIT 1", [
    uuid,
  ]);
  return res.rows[0]?.status ?? null;
}

describe("agent lifecycle — create / read / patch / suspend / reactivate / delete", () => {
  it("GET /agents/:uuid returns the freshly-created agent", async () => {
    const creds = readCredentialsOrThrow(handle);
    const got = await authedJson<{ uuid: string; displayName: string; type: string }>(
      handle.serverBaseUrl,
      creds.accessToken,
      "GET",
      `/api/v1/agents/${encodeURIComponent(agentId)}`,
    );
    expect(got.uuid).toBe(agentId);
    expect(got.type).toBe("agent");
    expect(got.displayName).toBe("Lifecycle target");
    expect(await readAgentStatus(agentId)).toBe("active");
  });

  it("PATCH /agents/:uuid updates displayName and visibility", async () => {
    const creds = readCredentialsOrThrow(handle);
    // `delegateMention` is intentionally NOT exercised here — the server
    // rejects it on autonomous agents ("delegateMention can only be set on
    // human agents") and this test uses an autonomous agent because the
    // fixture's human agent isn't ours to mutate.
    const patched = await authedJson<{ uuid: string; displayName: string; visibility: string }>(
      handle.serverBaseUrl,
      creds.accessToken,
      "PATCH",
      `/api/v1/agents/${encodeURIComponent(agentId)}`,
      { displayName: "Renamed lifecycle target", visibility: "private" },
    );
    expect(patched.displayName).toBe("Renamed lifecycle target");
    expect(patched.visibility).toBe("private");

    // Re-read to confirm the persisted state matches the patch response.
    const got = await authedJson<{ displayName: string; visibility: string }>(
      handle.serverBaseUrl,
      creds.accessToken,
      "GET",
      `/api/v1/agents/${encodeURIComponent(agentId)}`,
    );
    expect(got.displayName).toBe("Renamed lifecycle target");
    expect(got.visibility).toBe("private");
  });

  it("POST /agents/:uuid/suspend flips status active → suspended", async () => {
    const creds = readCredentialsOrThrow(handle);
    const res = await authedFetch(
      handle.serverBaseUrl,
      creds.accessToken,
      "POST",
      `/api/v1/agents/${encodeURIComponent(agentId)}/suspend`,
    );
    expect(res.status).toBe(200);
    expect(await readAgentStatus(agentId)).toBe("suspended");
  });

  it("POST /agents/:uuid/reactivate flips status suspended → active", async () => {
    const creds = readCredentialsOrThrow(handle);
    const res = await authedFetch(
      handle.serverBaseUrl,
      creds.accessToken,
      "POST",
      `/api/v1/agents/${encodeURIComponent(agentId)}/reactivate`,
    );
    expect(res.status).toBe(200);
    expect(await readAgentStatus(agentId)).toBe("active");
  });

  it("DELETE /agents/:uuid removes a suspended agent and tombstones the row", async () => {
    const creds = readCredentialsOrThrow(handle);

    // The DELETE handler refuses active agents ("Only suspended agents can
    // be deleted. Suspend the agent first.") — re-suspend before deleting.
    // The previous test re-activated the row; this is a real ordering rule,
    // not a test-setup quirk.
    const suspendRes = await authedFetch(
      handle.serverBaseUrl,
      creds.accessToken,
      "POST",
      `/api/v1/agents/${encodeURIComponent(agentId)}/suspend`,
    );
    expect(suspendRes.status).toBe(200);

    const delRes = await authedFetch(
      handle.serverBaseUrl,
      creds.accessToken,
      "DELETE",
      `/api/v1/agents/${encodeURIComponent(agentId)}`,
    );
    expect(delRes.status).toBe(204);
    // The agent service tombstones via `status='deleted'` rather than a
    // hard DELETE so the name becomes reusable (see services/agent.ts
    // `deleteAgent`). Assert that shape directly instead of expecting NULL.
    expect(await readAgentStatus(agentId)).toBe("deleted");

    const getRes = await authedFetch(
      handle.serverBaseUrl,
      creds.accessToken,
      "GET",
      `/api/v1/agents/${encodeURIComponent(agentId)}`,
    );
    expect(getRes.status).toBe(404);
  });
});
