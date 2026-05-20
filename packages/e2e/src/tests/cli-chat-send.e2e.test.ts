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
 *   3. Spawn the dist CLI: `chat send <recipientName> "..."` with
 *      `--agent <senderName>`. The CLI's own SIGTERM handlers stay out of
 *      our way because this is one-shot (not `client start`).
 *   4. Assert exit code 0 and that the resulting message is visible via the
 *      same `GET /api/v1/chats/:id/messages` route the web uses.
 *
 * Requires `E2E_WITH_CLIENT=1` (we lean on the fixture credentials + home).
 */

let handle: CurrentRunHandle;
let recipientName: string;
let pg: PgClient;

beforeAll(async () => {
  handle = readCurrentHandle();
  const creds = readCredentialsOrThrow(handle);

  // Recipient: a fresh autonomous agent pinned to the fixture client (so it
  // passes manager-in-org + clientId checks without needing a second user).
  recipientName = `e2e-cli-recipient-${randomBytes(3).toString("hex")}`;
  await authedJson<{ uuid: string }>(
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

  // Plant the local agent.yaml for the fixture human agent. The CLI scans
  // `${FIRST_TREE_HUB_HOME}/config/agents/*/agent.yaml`; entry name = agent
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

    // `--direct` opens (or reuses) the human ↔ recipient DM and skips the
    // "is the recipient a member of your current chat?" check. Without it
    // the server returns 400 because the test doesn't pre-bind the human to
    // the same chat first — exactly the error a user would hit running
    // `chat send` from a fresh shell without a current-chat context.
    const result = await execCli({
      home: handle.clientHome,
      serverBaseUrl: handle.serverBaseUrl,
      args: ["chat", "send", "--direct", recipientName, messageBody, "--agent", creds.humanAgentName],
      timeoutMs: 15_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `chat send exited with code ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }

    // Verify via PG rather than `GET /chats/:id/messages`: the direct-chat
    // path may open a fresh chat row we don't know the id of (chat type
    // resolution is server-side; `--direct` doesn't echo it on stdout in a
    // stable shape). Querying by `content` + `sender_id` pins the assertion
    // to the durable contract (a row exists with the expected sender) and
    // sidesteps direct-vs-dm chat-typing internals.
    // `messages.content` is `jsonb` — a text message is stored as the
    // JSON string `"the body"` (note the literal quotes). Match by casting
    // a text-typed bind to jsonb so we compare apples to apples without
    // needing a substring / `::text` ts-query workaround.
    // `messages.content` is `jsonb`; the `--direct` path on `chat send`
    // auto-prepends `@<recipientName> ` so the content stored is e.g.
    // `"@e2e-cli-recipient-… cli-send abc"`, not the raw `messageBody`.
    // Substring match through `content::text` is the most robust way to
    // assert "the body we sent is in there" without leaking the
    // mention-prepend behavior into the test contract.
    const row = await pg.query<{ id: string; sender_id: string; format: string }>(
      "SELECT id, sender_id, format FROM messages WHERE content::text LIKE '%' || $1 || '%' LIMIT 1",
      [messageBody],
    );
    expect(row.rows[0], `message "${messageBody}" not found in PG`).toBeDefined();
    expect(row.rows[0]?.sender_id).toBe(creds.humanAgentId);
    expect(row.rows[0]?.format).toBe("text");
  });
});
