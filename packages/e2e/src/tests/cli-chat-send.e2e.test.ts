import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execCli } from "../framework/cli-driver/exec.js";
import { type CurrentRunHandle, readCredentialsOrThrow, readCurrentHandle } from "../framework/current-handle.js";
import { authedJson } from "../framework/server-driver/http.js";

/**
 * CLI chat-send e2e — covers the user-facing `first-tree-hub chat send`
 * surface end-to-end against a real spawned dist CLI process, not just an
 * HTTP test against the underlying route.
 *
 * Why drive the CLI itself: the chat-send route is already covered by
 * `messaging.e2e.test.ts`; what's NOT covered is the CLI's local sender
 * resolution path (`agents/<name>/agent.yaml` → `agentId` → `X-Agent-Id`
 * header on the SDK call) and the dist tarball's "credentials.json found,
 * agent.yaml found, send works" happy path. A regression on the CLI side
 * of that contract would slip past every HTTP-only test.
 *
 * Sequence:
 *   1. POST an autonomous agent as the recipient through the public HTTP API.
 *   2. Plant `${fixtureHome}/config/agents/<humanAgentName>/agent.yaml` so
 *      the CLI's `resolveLocalAgent` knows the fixture human agent as the
 *      sender. (`credentials.ts` only plants credentials.json + client.yaml;
 *      `agents/` is the per-agent registration the operator would normally
 *      add via `first-tree-hub agent add` after `connect`.)
 *   3. Create a 2-party chat with [human, recipient] via the public API
 *      and pass its id as `FIRST_TREE_CHAT_ID` — the CLI's new
 *      group-chat-only model (PR #465) requires the sender's "current
 *      chat" to be set + the recipient to already be a participant.
 *   4. Spawn the dist CLI: `chat send <recipientName> "..."` with
 *      `--agent <senderName>`. The CLI's own SIGTERM handlers stay out of
 *      our way because this is one-shot (not `client start`).
 *   5. Assert exit code 0 and that the resulting message is visible via the
 *      same `GET /api/v1/chats/:id/messages` route the web uses.
 *
 * Requires `E2E_WITH_CLIENT=1` (we lean on the fixture credentials + home).
 */

let handle: CurrentRunHandle;
let recipientName: string;
let chatId: string;
let pg: PgClient;

beforeAll(async () => {
  handle = readCurrentHandle();
  const creds = readCredentialsOrThrow(handle);

  // Recipient: a fresh autonomous agent pinned to the fixture client (so it
  // passes manager-in-org + clientId checks without needing a second user).
  recipientName = `e2e-cli-recipient-${randomBytes(3).toString("hex")}`;
  const recipient = await authedJson<{ uuid: string }>(
    handle.serverBaseUrl,
    creds.accessToken,
    "POST",
    `/api/v1/orgs/${encodeURIComponent(creds.organizationId)}/agents`,
    {
      name: recipientName,
      type: "autonomous_agent",
      displayName: "CLI chat-send recipient",
      clientId: creds.clientId,
    },
    201,
  );

  // Pre-create the chat with both participants. With the v1 group-chat-only
  // model the CLI no longer has a `--direct` flag to open a DM on the fly
  // — the sender's current chat (via FIRST_TREE_CHAT_ID) must already
  // contain the recipient. A 2-member chat is exempt from
  // `enforceGroupMention`, so plain content body still works.
  const chat = await authedJson<{ chatId: string }>(
    handle.serverBaseUrl,
    creds.accessToken,
    "POST",
    `/api/v1/orgs/${encodeURIComponent(creds.organizationId)}/chats`,
    { participantIds: [recipient.uuid] },
    201,
  );
  chatId = chat.chatId;

  // Plant the local agent.yaml for the fixture human agent. The CLI scans
  // `${FIRST_TREE_HOME}/config/agents/*/agent.yaml`; entry name = agent
  // name; `agentId` field = server-side `agents.uuid`. Two lines is enough
  // — `runtime`/`concurrency`/`session.*` all have defaults on the schema.
  const senderAgentDir = resolve(handle.clientHome, "config", "agents", creds.humanAgentName);
  mkdirSync(senderAgentDir, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(senderAgentDir, "agent.yaml"), `agentId: ${creds.humanAgentId}\n`, { mode: 0o600 });

  pg = new PgClient({ connectionString: handle.databaseUrl });
  await pg.connect();
});

afterAll(async () => {
  await pg.end().catch(() => undefined);
});

describe("CLI `chat send` happy path against spawned dist CLI", () => {
  it("exits 0 and the message lands in PG with the fixture human as sender", async () => {
    const creds = readCredentialsOrThrow(handle);
    const messageBody = `cli-send ${randomBytes(3).toString("hex")}`;

    // FIRST_TREE_CHAT_ID feeds the CLI's "current chat" resolver — the
    // pre-created 2-party chat already lists recipientName as a member, so
    // `chat send` lands without needing `chat add-participant` first.
    const result = await execCli({
      home: handle.clientHome,
      serverBaseUrl: handle.serverBaseUrl,
      args: ["chat", "send", recipientName, messageBody, "--agent", creds.humanAgentName],
      extraEnv: { FIRST_TREE_CHAT_ID: chatId },
      timeoutMs: 15_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `chat send exited with code ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }

    // Verify via PG scoped to the pre-created chat so the assertion stays
    // pinned even if another test happens to plant a message with the
    // same random suffix. `messages.content` is `jsonb`; substring match
    // through `content::text` survives the wrapping quotes and any
    // future auto-prepend behavior the CLI might re-introduce.
    const row = await pg.query<{ id: string; sender_id: string; format: string }>(
      "SELECT id, sender_id, format FROM messages WHERE chat_id = $1 AND content::text LIKE '%' || $2 || '%' LIMIT 1",
      [chatId, messageBody],
    );
    expect(row.rows[0], `message "${messageBody}" not found in PG`).toBeDefined();
    expect(row.rows[0]?.sender_id).toBe(creds.humanAgentId);
    expect(row.rows[0]?.format).toBe("text");
  });
});
