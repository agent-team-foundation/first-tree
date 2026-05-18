import { randomUUID } from "node:crypto";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CurrentRunHandle, readCurrentHandle } from "../framework/current-handle.js";
import { type GitHubMock, startGithubMock } from "../framework/github-mock.js";

/**
 * GitHub webhook e2e — drives the server's `/api/v1/webhooks/github-app`
 * handler end-to-end through `github-mock`, then asserts the side-effects
 * landed in PG. Doesn't require `E2E_WITH_CLIENT=1` — the webhook path is
 * fully server-driven, no client involvement.
 *
 * Two side-effect surfaces exercised in M2:
 *   - `ping` event → 200 fast-path. Confirms HMAC + headers + parse work.
 *   - `installation.created` → upsert into `github_app_installations`.
 *     This is the only event the server processes without an existing
 *     bound row, so it's the natural M2 entry point.
 *
 * Out of M2 scope: PR / push event delivery into chat — those require the
 * outbound `api.github.com` proxy + a bound hub org, deferred to the
 * follow-up test once `github-mock.fastify` carries the relevant stubs.
 */

let handle: CurrentRunHandle;
let mock: GitHubMock;

beforeAll(async () => {
  handle = readCurrentHandle();
  mock = await startGithubMock({
    serverBaseUrl: handle.serverBaseUrl,
    webhookSecret: handle.githubWebhookSecret,
  });
});

afterAll(async () => {
  await mock.stop();
});

describe("M2 github-webhook — signed POST → server side-effects", () => {
  it("ping event returns 200 with the expected fast-path body", async () => {
    const result = await mock.emit("ping", { zen: "Practicality beats purity." });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, event: "ping" });
  });

  it("rejects an unsigned (mismatched) payload with 401", async () => {
    // Tamper-detect: emit a payload then mutate it server-side by sending a
    // request with the right signature for a DIFFERENT body. We do it by
    // bypassing the mock and crafting the request ourselves — easier than
    // adding a knob to the mock just for the failure path.
    const badBody = Buffer.from(JSON.stringify({ zen: "tampered" }), "utf8");
    const wrongSignature = "sha256=" + "a".repeat(64);
    const res = await fetch(`${handle.serverBaseUrl}/api/v1/webhooks/github-app`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "ping",
        "X-GitHub-Delivery": randomUUID(),
        "X-Hub-Signature-256": wrongSignature,
      },
      body: badBody,
    });
    expect(res.status).toBe(401);
  });

  it("installation.created upserts a row in github_app_installations", async () => {
    const githubInstallationId = 100_000 + Math.floor(Math.random() * 900_000);
    const accountGithubId = 200_000 + Math.floor(Math.random() * 800_000);
    const accountLogin = `e2e-acct-${githubInstallationId}`;

    const result = await mock.emit("installation", {
      action: "created",
      installation: {
        id: githubInstallationId,
        account: { id: accountGithubId, login: accountLogin, type: "Organization" },
        permissions: { contents: "write", pull_requests: "write", issues: "read" },
        events: ["push", "pull_request", "issues"],
        suspended_at: null,
      },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, event: "installation", lifecycle: "created" });

    const pg = new PgClient({ connectionString: handle.databaseUrl });
    await pg.connect();
    try {
      const rows = await pg.query<{
        installation_id: number;
        account_login: string;
        account_github_id: number;
        events: string[];
      }>(
        "SELECT installation_id, account_login, account_github_id, events FROM github_app_installations WHERE installation_id = $1",
        [githubInstallationId],
      );
      expect(rows.rows).toHaveLength(1);
      const row = rows.rows[0];
      expect(row).toBeDefined();
      if (!row) return;
      expect(Number(row.installation_id)).toBe(githubInstallationId);
      expect(row.account_login).toBe(accountLogin);
      expect(Number(row.account_github_id)).toBe(accountGithubId);
      // events stored as jsonb array — pg returns it as a JS array directly.
      expect(row.events).toContain("push");
    } finally {
      await pg.end();
    }
  });
});
