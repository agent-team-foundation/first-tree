import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client as PgClient } from "pg";
import { REPO_ROOT } from "./env.js";
import type { ComponentLogger } from "./logging.js";

const CLI_ENTRY = resolve(REPO_ROOT, "packages/command/dist/cli/index.mjs");

export type DevUserSession = {
  /** PID of the long-running `client start --foreground` process. */
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
 * Walk the real "log in as Dev User → generate connect-token → CLI client
 * start" path end-to-end:
 *
 *   1. dev-callback bypass → user JWT pair (mimics the web Continue-as-Dev-User
 *      button)
 *   2. POST /me/connect-tokens → short-lived connect-token (mimics the web
 *      "Add CLI" button)
 *   3. POST /auth/connect-token → user JWT pair from the connect-token (the
 *      `first-tree-hub connect` command's `exchangeToken` step)
 *   4. Plant credentials.json + client.yaml on disk under `${runHome}-devuser`
 *      so the spawned CLI doesn't need to run an interactive connect
 *   5. spawn `client start --foreground --no-interactive`, which is what a
 *      real installed background service would run — critically, this path
 *      probes local runtime SDKs (claude-code / codex) and PATCHes
 *      `clients.metadata.capabilities`, which the web onboarding flow then
 *      reads to decide "no runtime ready on this computer" vs. "ready"
 *
 * `first-tree-hub connect <token> --no-service` is deliberately NOT used:
 * connect's inline-running path skips the capabilities probe, leaving
 * `clients.metadata` NULL and the web onboarding step 2 stuck on
 * "No runtime ready on this computer". `client start --foreground` is the
 * canonical long-running entry point and is what the service unit invokes.
 *
 * Requires the server to have been booted with
 * `FIRST_TREE_HUB_DEV_CALLBACK_ENABLED=1` — otherwise dev-callback returns 404.
 */
export async function setupDevUser(opts: SetupDevUserOptions): Promise<DevUserSession> {
  // Step 1: dev-callback → access/refresh in URL fragment.
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
  const ctRes = await fetch(new URL("/api/v1/me/connect-tokens", opts.serverBaseUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${devAccess}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!ctRes.ok) throw new Error(`POST /me/connect-tokens failed (HTTP ${ctRes.status}): ${await ctRes.text()}`);
  const { token: connectToken } = (await ctRes.json()) as { token: string };

  // Step 3: /auth/connect-token → access/refresh user JWT pair, exactly what
  // the CLI's `exchangeToken` does.
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

  // Step 4: plant credentials.json + client.yaml so `client start` finds them.
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

  // Step 5: spawn `client start --foreground --no-interactive`. We strip
  // ambient FIRST_TREE_HUB_* env so a parent process running inside another
  // agent runtime (e.g. an agent on prod hub) doesn't leak its server URL
  // into the spawned CLI via env-over-file config priority.
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("FIRST_TREE_HUB_")) continue;
    sanitized[k] = v;
  }
  const env: NodeJS.ProcessEnv = {
    ...sanitized,
    NODE_ENV: "test",
    FIRST_TREE_HUB_HOME: devHome,
    FIRST_TREE_HUB_SERVER_URL: opts.serverBaseUrl,
  };

  const child = spawn(process.execPath, [CLI_ENTRY, "client", "start", "--foreground", "--no-interactive"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: REPO_ROOT,
  });
  child.stdout?.on("data", (c) => opts.logger.pipe(c));
  child.stderr?.on("data", (c) => opts.logger.pipe(c));

  // Step 6: poll PG until the CLI's WS handshake landed AND the capabilities
  // upload completed. Without the metadata gate the web onboarding flow
  // still shows "No runtime ready" because clients.metadata is NULL right
  // up until reconcile finishes.
  const pg = new PgClient({ connectionString: opts.databaseUrl });
  await pg.connect();
  let userRow: { id: string } | undefined;
  let clientRow: { id: string; organization_id: string } | undefined;
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`devuser client process exited early (code=${child.exitCode})`);
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
  const agentRes = await fetch(`${opts.serverBaseUrl}/api/v1/orgs/${encodeURIComponent(orgId)}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      name: agentName,
      type: "autonomous_agent",
      displayName: "Dev User's Assistant",
      clientId: clientRow.id,
    }),
  });
  if (agentRes.status !== 201) {
    throw new Error(`POST /agents failed (HTTP ${agentRes.status}): ${await agentRes.text()}`);
  }
  const { uuid: agentId } = (await agentRes.json()) as { uuid: string };

  const chatRes = await fetch(`${opts.serverBaseUrl}/api/v1/orgs/${encodeURIComponent(orgId)}/chats`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ participantIds: [agentId] }),
  });
  if (chatRes.status !== 201) {
    throw new Error(`POST /chats failed (HTTP ${chatRes.status}): ${await chatRes.text()}`);
  }
  const { chatId } = (await chatRes.json()) as { chatId: string };

  const msgRes = await fetch(`${opts.serverBaseUrl}/api/v1/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      format: "text",
      content: "Hello from the e2e environment — this message was posted via POST /chats/:id/messages.",
    }),
  });
  if (msgRes.status !== 201) {
    throw new Error(`POST /chats/:id/messages failed (HTTP ${msgRes.status}): ${await msgRes.text()}`);
  }
  const { id: firstMessageId } = (await msgRes.json()) as { id: string };

  return {
    pid: child.pid ?? -1,
    home: devHome,
    userId: userRow.id,
    username: "devuser",
    clientId: clientRow.id,
    organizationId: orgId,
    agentId,
    agentName,
    chatId,
    firstMessageId,
    stop: () => killChild(child),
  };
}

async function killChild(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const timer = new Promise<void>((resolve) =>
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve();
    }, 5_000),
  );
  await Promise.race([done, timer]);
}
