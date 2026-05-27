import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client as PgClient } from "pg";
import { type SpawnedCli, spawnCli } from "./cli-driver/exec.js";
import type { ComponentLogger } from "./logging.js";
import { authedJson } from "./server-driver/http.js";

export type DevUserSession = {
  /** PID of the long-running `daemon start --foreground` process. */
  pid: number;
  /** Per-session home so devuser doesn't collide with the fixture home. */
  home: string;
  /** Hub-side identifiers, fetched from PG after WS register completes. */
  userId: string;
  username: string;
  clientId: string;
  organizationId: string;
  /** Autonomous agent created via POST /agents on the devuser's org. */
  agentId: string;
  agentName: string;
  /** Chat with the autonomous agent created via POST /chats. */
  chatId: string;
  /** Id of the first message the human-agent posted into the chat. */
  firstMessageId: string;
  stop: () => Promise<void>;
};

export type SetupDevUserOptions = {
  serverBaseUrl: string;
  databaseUrl: string;
  /** Per-run home root; devuser home becomes `${runHome}-devuser`. */
  runHome: string;
  logger: ComponentLogger;
};

/**
 * Walk the real "log in as Dev User → generate connect-token → CLI daemon
 * start" path end-to-end:
 *
 *   1. dev-callback bypass → user JWT pair (mimics the web Continue-as-Dev-User
 *      button)
 *   2. POST /me/connect-tokens → short-lived connect-token (mimics the web
 *      "Add CLI" button)
 *   3. POST /auth/connect-token → user JWT pair from the connect-token (the
 *      `first-tree login` command's `exchangeToken` step)
 *   4. Plant credentials.json + client.yaml on disk under `${runHome}-devuser`
 *      so the spawned CLI doesn't need to run an interactive login
 *   5. spawn `daemon start --foreground --no-interactive`, which is what a
 *      real installed background service would run — critically, this path
 *      probes local runtime SDKs (claude-code / codex) and PATCHes
 *      `clients.metadata.capabilities`, which the web onboarding flow then
 *      reads to decide "no runtime ready on this computer" vs. "ready"
 *
 * `first-tree login <token> --no-start` is deliberately NOT used here:
 * its inline-running path skips the capabilities probe, leaving
 * `clients.metadata` NULL and the web onboarding step 2 stuck on
 * "No runtime ready on this computer". `daemon start --foreground` is the
 * canonical long-running entry point and is what the service unit invokes.
 *
 * Requires the server to have been booted with
 * `FIRST_TREE_DEV_CALLBACK_ENABLED=1` — otherwise dev-callback returns 404.
 */
export async function setupDevUser(opts: SetupDevUserOptions): Promise<DevUserSession> {
  // Step 1: dev-callback → access/refresh in URL fragment. `authedFetch`
  // isn't right here (no bearer yet), so we go through `fetch` directly.
  const devCallbackUrl = new URL("/api/v1/auth/github/dev-callback", opts.serverBaseUrl);
  devCallbackUrl.searchParams.set("githubId", "1");
  devCallbackUrl.searchParams.set("login", "devuser");
  devCallbackUrl.searchParams.set("displayName", "Dev User");
  const cbRes = await fetch(devCallbackUrl, { redirect: "manual" });
  if (cbRes.status !== 302) {
    throw new Error(`dev-callback expected 302, got ${cbRes.status}: ${await cbRes.text()}`);
  }
  const location = cbRes.headers.get("location");
  if (!location) throw new Error("dev-callback returned 302 without Location header");
  const hashIdx = location.indexOf("#");
  if (hashIdx < 0) throw new Error(`dev-callback Location has no fragment: ${location}`);
  const frag = new URLSearchParams(location.slice(hashIdx + 1));
  const devAccess = frag.get("access");
  const devRefresh = frag.get("refresh");
  if (!devAccess || !devRefresh) {
    // Refresh isn't used downstream right now (the connect-token step mints
    // a fresh pair), but failing fast here catches an upstream contract
    // change where dev-callback would silently drop one of the fields.
    throw new Error(`dev-callback fragment missing access/refresh: ${location}`);
  }

  // Step 2: /me/connect-tokens → connect-token.
  const { token: connectToken } = await authedJson<{ token: string }>(
    opts.serverBaseUrl,
    devAccess,
    "POST",
    "/api/v1/me/connect-tokens",
    {},
  );

  // Step 3: /auth/connect-token → access/refresh user JWT pair, the same
  // exchange the CLI's own `connect <token>` command performs. No bearer
  // header — the connect-token is the credential.
  const exRes = await fetch(new URL("/api/v1/auth/connect-token", opts.serverBaseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: connectToken }),
  });
  if (!exRes.ok) throw new Error(`/auth/connect-token failed (HTTP ${exRes.status}): ${await exRes.text()}`);
  const { accessToken, refreshToken } = (await exRes.json()) as {
    accessToken: string;
    refreshToken: string;
  };

  // Step 4: plant credentials.json + client.yaml so `daemon start` finds them.
  const devHome = `${opts.runHome}-devuser`;
  const configDir = resolve(devHome, "config");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const clientId = `client_${randomBytes(4).toString("hex")}`;
  writeFileSync(
    resolve(configDir, "credentials.json"),
    JSON.stringify({ accessToken, refreshToken, serverUrl: opts.serverBaseUrl }, null, 2),
    { mode: 0o600 },
  );
  writeFileSync(
    resolve(configDir, "client.yaml"),
    `server:\n  url: ${opts.serverBaseUrl}\nclient:\n  id: ${clientId}\n`,
    { mode: 0o600 },
  );

  // Step 5: spawn `daemon start --foreground --no-interactive`. `spawnCli`
  // sanitizes ambient `FIRST_TREE_*` env so the per-run client.yaml
  // wins over any parent-process server URL.
  const client: SpawnedCli = await spawnCli({
    home: devHome,
    serverBaseUrl: opts.serverBaseUrl,
    args: ["daemon", "start", "--foreground", "--no-interactive"],
    logger: opts.logger,
  });

  // Step 6: poll PG until the CLI's WS handshake landed AND the capabilities
  // upload completed. Without the metadata gate the web onboarding flow
  // still shows "No runtime ready" because clients.metadata is NULL right
  // up until the runtime-reconcile PATCH finishes.
  const pg = new PgClient({ connectionString: opts.databaseUrl });
  await pg.connect();
  let userRow: { id: string } | undefined;
  let clientRow: { id: string; organization_id: string } | undefined;
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (client.child.exitCode !== null) {
        throw new Error(`devuser client process exited early (code=${client.child.exitCode})`);
      }
      const u = await pg.query<{ id: string }>("SELECT id FROM users WHERE username = $1 LIMIT 1", ["devuser"]);
      userRow = u.rows[0];
      if (userRow) {
        const c = await pg.query<{ id: string; organization_id: string }>(
          `SELECT id, organization_id FROM clients
            WHERE user_id = $1 AND status = 'connected' AND metadata IS NOT NULL
            LIMIT 1`,
          [userRow.id],
        );
        clientRow = c.rows[0];
        if (clientRow) break;
      }
      await new Promise<void>((r) => setTimeout(r, 250));
    }
    if (!userRow) throw new Error("devuser user row never appeared in PG after dev-callback");
    if (!clientRow) {
      throw new Error(
        "devuser client never registered as 'connected' with metadata within 30s (capabilities upload missing)",
      );
    }
  } finally {
    await pg.end();
  }

  // Step 7: seed a real autonomous agent + chat + first message through the
  // PUBLIC HTTP API using the devuser access token, so a human signing into
  // the web app lands on a workspace that already has something to look at
  // (instead of being stranded on the onboarding wizard). All three calls go
  // through the same validation surface the web does — agent name regex,
  // R-RUN, manager-in-org, etc.
  const orgId = clientRow.organization_id;
  const agentName = `devuser-asst-${randomBytes(3).toString("hex")}`;
  const { uuid: agentId } = await authedJson<{ uuid: string }>(
    opts.serverBaseUrl,
    accessToken,
    "POST",
    `/api/v1/orgs/${encodeURIComponent(orgId)}/agents`,
    {
      name: agentName,
      type: "agent",
      displayName: "Dev User's Assistant",
      clientId: clientRow.id,
    },
    201,
  );

  const { chatId } = await authedJson<{ chatId: string }>(
    opts.serverBaseUrl,
    accessToken,
    "POST",
    `/api/v1/orgs/${encodeURIComponent(orgId)}/chats`,
    { participantIds: [agentId] },
    201,
  );

  const { id: firstMessageId } = await authedJson<{ id: string }>(
    opts.serverBaseUrl,
    accessToken,
    "POST",
    `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
    {
      format: "text",
      content: "Hello from the e2e environment — this message was posted via POST /chats/:id/messages.",
    },
    201,
  );

  return {
    pid: client.pid,
    home: devHome,
    userId: userRow.id,
    username: "devuser",
    clientId: clientRow.id,
    organizationId: orgId,
    agentId,
    agentName,
    chatId,
    firstMessageId,
    stop: client.stop,
  };
}
