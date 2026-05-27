import { randomBytes } from "node:crypto";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CurrentRunHandle, readCredentialsOrThrow, readCurrentHandle } from "../framework/current-handle.js";
import { authedJson } from "../framework/server-driver/http.js";
import { connectWsListener, type WsListener } from "../framework/server-driver/ws.js";

/**
 * Phase-1 GitHub entity binding via tool_call stdout extraction.
 *
 * Flow under test (`services/session-event.ts:appendEvent` →
 * `services/github-entity-chat.ts:maybeBindGithubEntityFromToolCall`):
 *
 *   1. A non-human "reporter" agent (delegate) is a participant in a chat
 *      with exactly one active human member.
 *   2. The reporter emits a `session:event` WS frame with
 *      `event.kind = "tool_call"` whose payload reports a successful
 *      `gh pr create` / `gh issue create` and whose `resultPreview`
 *      contains the resulting GitHub URL.
 *   3. `extractGithubEntity` parses the URL, `resolveBindingPair`
 *      picks the chat's human as the binding partner, and a row lands
 *      in `github_entity_chat_mappings` with `bound_via = 'agent_created'`.
 *
 * The point: the next `pull_request.opened` webhook for the same entity
 * routes back to the seeded chat (the github-pr-delivery test exercises
 * that side via `pull_request.synchronize`). Without the bind, a fresh
 * chat would fork and the agent's work would appear disconnected.
 *
 * We only exercise the **PR** path here. The issue path is structurally
 * identical (different regex + entity_type literal); covering one of the
 * two prevents the slip-shaped regression risk worth catching at e2e
 * granularity.
 *
 * Requires `E2E_WITH_CLIENT=1`.
 */

const REPO = `e2e-org/e2e-stdout-${randomBytes(2).toString("hex")}`;
const PR_NUMBER = 137;
const ENTITY_KEY = `${REPO}#${PR_NUMBER}`;
const PR_URL = `https://github.com/${REPO}/pull/${PR_NUMBER}`;

let handle: CurrentRunHandle;
let listenerClientId: string;
let reporterAgentId: string;
let chatId: string;
let listener: WsListener;
let pg: PgClient;

beforeAll(async () => {
  handle = readCurrentHandle();
  const creds = readCredentialsOrThrow(handle);
  listenerClientId = `client_${randomBytes(4).toString("hex")}`;

  pg = new PgClient({ connectionString: handle.databaseUrl });
  await pg.connect();
  await pg.query("INSERT INTO clients (id, user_id, organization_id) VALUES ($1, $2, $3)", [
    listenerClientId,
    creds.userId,
    creds.organizationId,
  ]);

  // Autonomous agent = reporter (delegate side of the future mapping).
  reporterAgentId = (
    await authedJson<{ uuid: string }>(
      handle.serverBaseUrl,
      creds.accessToken,
      "POST",
      `/api/v1/orgs/${encodeURIComponent(creds.organizationId)}/agents`,
      {
        name: `e2e-stdout-${randomBytes(3).toString("hex")}`,
        type: "agent",
        displayName: "E2E Stdout Reporter",
        clientId: listenerClientId,
      },
      201,
    )
  ).uuid;

  // Direct chat between the credentials' human agent (creator) and the
  // reporter. `resolveBindingPair` picks the human as binding partner.
  chatId = (
    await authedJson<{ chatId: string }>(
      handle.serverBaseUrl,
      creds.accessToken,
      "POST",
      `/api/v1/orgs/${encodeURIComponent(creds.organizationId)}/chats`,
      { participantIds: [reporterAgentId] },
      201,
    )
  ).chatId;

  listener = await connectWsListener({
    serverBaseUrl: handle.serverBaseUrl,
    accessToken: creds.accessToken,
    clientId: listenerClientId,
    bindAgents: [{ agentId: reporterAgentId }],
  });
});

afterAll(async () => {
  await listener?.close();
  await pg.end().catch(() => undefined);
});

async function readMapping(): Promise<{
  human_agent_id: string;
  delegate_agent_id: string;
  bound_via: string;
} | null> {
  const res = await pg.query<{
    human_agent_id: string;
    delegate_agent_id: string;
    bound_via: string;
  }>(
    `SELECT human_agent_id, delegate_agent_id, bound_via
     FROM github_entity_chat_mappings
     WHERE chat_id = $1 AND entity_type = 'pull_request' AND entity_key = $2
     LIMIT 1`,
    [chatId, ENTITY_KEY],
  );
  return res.rows[0] ?? null;
}

async function readMaxSeq(): Promise<number> {
  const res = await pg.query<{ max_seq: number | null }>(
    "SELECT MAX(seq)::int AS max_seq FROM session_events WHERE agent_id = $1 AND chat_id = $2",
    [reporterAgentId, chatId],
  );
  return res.rows[0]?.max_seq ?? 0;
}

async function readMappingCount(): Promise<number> {
  const res = await pg.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM github_entity_chat_mappings
     WHERE chat_id = $1 AND entity_type = 'pull_request' AND entity_key = $2`,
    [chatId, ENTITY_KEY],
  );
  return Number(res.rows[0]?.n ?? "0");
}

describe("PR URL binding from tool_call stdout — Phase-1 agent-created mapping", () => {
  it("a successful `gh pr create` tool_call event writes a github_entity_chat_mappings row with bound_via='agent_created'", async () => {
    const creds = readCredentialsOrThrow(handle);

    // session:event frame mirrors `sessionEventMessageSchema` — outer
    // `agentId` lets the ws-client handler verify the agent is bound on
    // this socket, inner `event` carries the tool_call payload that the
    // extractor matches against (PR_COMMAND_RE + PR_URL_RE).
    listener.send({
      type: "session:event",
      agentId: reporterAgentId,
      chatId,
      event: {
        kind: "tool_call",
        payload: {
          toolUseId: `tooluse_${randomBytes(4).toString("hex")}`,
          name: "Bash",
          status: "ok",
          args: { command: `gh pr create --title "feat" --body "body"` },
          // The extractor scans `resultPreview` for a PR URL — short enough
          // to fit under the 400-char preview cap, as Phase-1 gh CLI
          // output always is in practice.
          resultPreview: `${PR_URL}\n`,
        },
      },
    });

    // appendEvent + maybeBindGithubEntityFromToolCall are async; the server
    // sends no ack. Poll PG with a short deadline rather than sleeping a
    // fixed interval — keeps the happy path fast while still tolerating
    // local-PG slowness.
    const deadline = Date.now() + 5_000;
    let mapping: Awaited<ReturnType<typeof readMapping>> = null;
    while (Date.now() < deadline && mapping === null) {
      mapping = await readMapping();
      if (mapping) break;
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    expect(mapping).not.toBeNull();
    if (!mapping) return;

    expect(mapping.delegate_agent_id).toBe(reporterAgentId);
    expect(mapping.human_agent_id).toBe(creds.humanAgentId);
    expect(mapping.bound_via).toBe("agent_created");

    // session_events row landed too — proves the binding side-effect
    // didn't unwind the primary write (insertMappingIfAbsent must be
    // fire-and-forget per services/session-event.ts:103).
    const seRow = await pg.query<{ kind: string }>(
      "SELECT kind FROM session_events WHERE agent_id = $1 AND chat_id = $2 ORDER BY seq DESC LIMIT 1",
      [reporterAgentId, chatId],
    );
    expect(seRow.rows[0]?.kind).toBe("tool_call");
  });

  it("re-emitting the same tool_call doesn't duplicate the mapping (idempotency)", async () => {
    // High-water mark on the events table: the second `session:event` is
    // persisted strictly *before* `maybeBindGithubEntityFromToolCall`
    // returns (the bind runs inside `appendEvent` itself — see
    // services/session-event.ts:102-106 — fire-and-forget in the JS-
    // promise sense but scheduled in the same tick as the INSERT). So
    // by the time `seq` has grown on a fresh PG round-trip, the bind's
    // ON-CONFLICT-DO-NOTHING attempt has already landed.
    const seqBefore = await readMaxSeq();
    expect(seqBefore).toBeGreaterThan(0);

    listener.send({
      type: "session:event",
      agentId: reporterAgentId,
      chatId,
      event: {
        kind: "tool_call",
        payload: {
          toolUseId: `tooluse_${randomBytes(4).toString("hex")}`,
          name: "Bash",
          status: "ok",
          args: { command: `gh pr create --title "feat" --body "body"` },
          resultPreview: `${PR_URL}\n`,
        },
      },
    });

    const deadline = Date.now() + 3_000;
    let seqAfter = seqBefore;
    while (Date.now() < deadline && seqAfter === seqBefore) {
      await new Promise<void>((r) => setTimeout(r, 50));
      seqAfter = await readMaxSeq();
    }
    expect(seqAfter).toBeGreaterThan(seqBefore);

    // Count must stay at 1 — the unique constraint backing
    // `insertMappingIfAbsent` (ON CONFLICT DO NOTHING) is the contract.
    expect(await readMappingCount()).toBe(1);
  });
});
