// End-to-end smoke for the AskUserQuestion roundtrip — runs the real Hub
// server (with the migrated DB) in-process, drives a real `format=question`
// message from an "agent" identity, drives a real answer POST from the
// "human" identity, and verifies the full data plane lit up correctly:
//
//   1. The question message lands in `messages` with `format='question'`.
//   2. `pending_questions` has a row keyed by correlationId, status=pending.
//   3. `assertSenderMayEmitQuestion` rejects a codex sender with HTTP 403.
//   4. POST /chats/:chatId/questions/:correlationId/answer returns 201.
//   5. The pending row flips to status=answered with answered_at set.
//   6. A new `format=question_answer` message exists with correlationId match.
//   7. archiveSession on the chat marks any other pending row as superseded.
//   8. claimClient on a separate agent's client marks its pending row
//      superseded.
//
// Designed so a regression in any of commits 1–5 surfaces as a non-zero
// exit. Run from inside `packages/server`:
//   DATABASE_URL=postgresql://firsttreehub:firsttreehub@localhost:5432/fth_e2e_askuser \
//   npx tsx scripts/e2e-askuser.mjs

import { randomUUID } from "node:crypto";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

// Boot the server in-process. We import from the workspace packages —
// `buildApp` from server, the shared schemas, the `claimClient` /
// `archiveSession` services. This is the same wiring `pnpm dev` would
// produce, just without the CLI shell.
const { buildApp } = await import("../src/app.ts");
const { sendMessage } = await import("../src/services/message.ts");
const { archiveSession, suspendSession } = await import("../src/services/session.ts");
const { claimClient } = await import("../src/services/client.ts");
const { createAgent } = await import("../src/services/agent.ts");
const { createChat } = await import("../src/services/chat.ts");
const { signTokensForUser } = await import("../src/services/auth.ts");
const { resolveDefaultOrgId, ensureDefaultOrganization } = await import("../src/services/organization.ts");
const { uuidv7 } = await import("../src/uuid.ts");
const sharedDbSchema = await import("../src/db/schema/index.ts");
const { eq } = await import("drizzle-orm");

const failures = [];
function expect(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

const config = {
  database: { url: DB_URL, provider: "external" },
  server: { port: 0, host: "127.0.0.1", publicUrl: undefined },
  secrets: {
    jwtSecret: "e2e-jwt-secret",
    encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
  auth: { accessTokenExpiry: "30m", refreshTokenExpiry: "30d", connectTokenExpiry: "10m" },
  github: { webhookSecret: "test-webhook-secret", allowedOrg: "test-org" },
  oauth: { github: { clientId: "x", clientSecret: "x" } },
  trustProxy: false,
  rateLimit: {
    max: 10000,
    loginMax: 10000,
    webhookMax: 10000,
    agentMessageMax: 10000,
    contextTreeSnapshotMax: 10000,
  },
  observability: { logging: { level: "error", format: "json", bridgeToSpanLevel: "off" } },
  runtime: {
    inboxTimeoutSeconds: 300,
    maxRetryCount: 3,
    pollingIntervalSeconds: 5,
    presenceCleanupSeconds: 60,
    notificationWebhookUrl: undefined,
  },
  instanceId: "e2e-askuser",
};

console.log("[e2e-askuser] booting in-process Hub server…");
const app = await buildApp(config);
await app.ready();
console.log("[e2e-askuser] server ready");

// Clean content tables so reruns are deterministic. Keep schema + drizzle
// metadata. `app.db.execute(sql.unsafe(...))` reuses the same drizzle
// connection the server holds — no new postgres dep needed.
const { sql: drizzleSql } = await import("drizzle-orm");
async function truncateAll() {
  await app.db.execute(drizzleSql.raw(`
    TRUNCATE TABLE pending_questions, inbox_entries, messages,
      agent_chat_sessions, agent_presence, chat_participants,
      chat_subscriptions, chats, agents, members, clients,
      users, organizations, auth_identities, agent_configs,
      notifications, invitation_redemptions, invitations,
      adapter_chat_mappings, adapter_agent_mappings,
      adapter_message_references, adapter_configs,
      session_events, server_instances, processed_events,
      tasks, task_chats
    RESTART IDENTITY CASCADE
  `));
}
await truncateAll();
// truncate wiped the default-org row that buildApp's onReady hook created;
// re-create it explicitly so the rest of the harness can resolve a default
// org for the test users / agents.
await ensureDefaultOrganization(app.db);

async function bootstrapUser() {
  const userId = uuidv7();
  const orgId = await resolveDefaultOrgId(app.db);
  const memberId = uuidv7();
  const username = `e2e-user-${randomUUID().slice(0, 6)}`;
  const humanAgent = await app.db.transaction(async (tx) => {
    await tx.insert(sharedDbSchema.users).values({
      id: userId,
      username,
      passwordHash: "$2b$04$" + "x".repeat(22) + "y".repeat(31),
      displayName: "E2E Tester",
    });
    const created = await createAgent(tx, {
      name: `e2e-tester-${randomUUID().slice(0, 6)}`,
      type: "human",
      displayName: "E2E Tester",
      source: "admin-api",
      managerId: memberId,
      organizationId: orgId,
    });
    await tx.insert(sharedDbSchema.members).values({
      id: memberId,
      userId,
      organizationId: orgId,
      agentId: created.uuid,
      role: "admin",
    });
    return created;
  });
  const tokens = await signTokensForUser("e2e-jwt-secret", userId, {
    accessTokenExpiry: "30m",
    refreshTokenExpiry: "30d",
  });
  const clientId = `cli-${randomUUID().slice(0, 8)}`;
  await app.db.insert(sharedDbSchema.clients).values({
    id: clientId,
    userId,
    organizationId: orgId,
    status: "connected",
  });
  return { userId, memberId, organizationId: orgId, humanAgent, accessToken: tokens.accessToken, clientId };
}

async function inject(method, url, accessToken, payload) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${accessToken}` },
    ...(payload ? { payload } : {}),
  });
}

// ── 1. Happy path: claude agent emits question → user answers → message lands ──
console.log("\n[e2e-askuser] case 1: happy-path roundtrip");
{
  const ctx = await bootstrapUser();
  const peer = await createAgent(
    app.db,
    {
      name: `e2e-peer-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Peer Agent",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    },
    { force: true },
  );
  const chat = await createChat(app.db, ctx.humanAgent.uuid, {
    type: "direct",
    participantIds: [peer.uuid],
  });

  const correlationId = `tu_e2e_${randomUUID().slice(0, 8)}`;
  const questionContent = {
    correlationId,
    questions: [
      {
        question: "Should I rebase or merge?",
        header: "Strategy",
        options: [
          { label: "Rebase", description: "Replay commits", preview: "<code>git rebase main</code>" },
          { label: "Merge", description: "Preserve history", preview: "<code>git merge main</code>" },
        ],
        multiSelect: false,
      },
    ],
    previewFormat: "html",
    allowFreeText: true,
  };

  const result = await sendMessage(app.db, chat.id, peer.uuid, {
    format: "question",
    content: questionContent,
  });
  expect(result.message.format === "question", "agent send produced format=question");

  const [pendingRow] = await app.db
    .select()
    .from(sharedDbSchema.pendingQuestions)
    .where(eq(sharedDbSchema.pendingQuestions.id, correlationId))
    .limit(1);
  expect(pendingRow !== undefined, "pending_questions row materialised");
  expect(pendingRow?.status === "pending", "pending row status=pending");
  expect(pendingRow?.agentId === peer.uuid, "pending row agent_id matches sender");
  expect(pendingRow?.chatId === chat.id, "pending row chat_id matches");
  expect(pendingRow?.messageId === result.message.id, "pending row message_id matches written message");

  const answerRes = await inject(
    "POST",
    `/api/v1/chats/${chat.id}/questions/${correlationId}/answer`,
    ctx.accessToken,
    { answers: { "Should I rebase or merge?": "Rebase" } },
  );
  expect(answerRes.statusCode === 201, `POST answer returns 201 (got ${answerRes.statusCode})`);
  const answerBody = answerRes.json();
  expect(answerBody.correlationId === correlationId, "answer response carries correlationId");

  const [updated] = await app.db
    .select()
    .from(sharedDbSchema.pendingQuestions)
    .where(eq(sharedDbSchema.pendingQuestions.id, correlationId))
    .limit(1);
  expect(updated?.status === "answered", "pending row flipped to answered");
  expect(updated?.answeredAt !== null, "answered_at timestamp set");

  const [answerMsg] = await app.db
    .select()
    .from(sharedDbSchema.messages)
    .where(eq(sharedDbSchema.messages.id, answerBody.messageId))
    .limit(1);
  expect(answerMsg?.format === "question_answer", "answer message has format=question_answer");
  expect(answerMsg?.inReplyTo === result.message.id, "answer in_reply_to points at the question");
  const answerContent = answerMsg?.content;
  expect(answerContent?.correlationId === correlationId, "answer content correlationId roundtrips");
  expect(answerContent?.answers["Should I rebase or merge?"] === "Rebase", "answer content carries selected option");

  // Second submit on the same correlation should 409 (already answered).
  const dupRes = await inject(
    "POST",
    `/api/v1/chats/${chat.id}/questions/${correlationId}/answer`,
    ctx.accessToken,
    { answers: { "Should I rebase or merge?": "Merge" } },
  );
  expect(dupRes.statusCode === 409, `duplicate answer returns 409 (got ${dupRes.statusCode})`);
}

// ── 2. Codex sender defense ──
console.log("\n[e2e-askuser] case 2: codex runtime defense");
{
  const ctx = await bootstrapUser();
  const codexPeer = await createAgent(
    app.db,
    {
      name: `e2e-codex-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Codex Peer",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "codex",
    },
    { force: true },
  );
  const chat = await createChat(app.db, ctx.humanAgent.uuid, {
    type: "direct",
    participantIds: [codexPeer.uuid],
  });

  const correlationId = `tu_codex_${randomUUID().slice(0, 8)}`;
  let threw = false;
  try {
    await sendMessage(app.db, chat.id, codexPeer.uuid, {
      format: "question",
      content: {
        correlationId,
        questions: [
          {
            question: "?",
            header: "Q",
            options: [
              { label: "A", description: "", preview: null },
              { label: "B", description: "", preview: null },
            ],
            multiSelect: false,
          },
        ],
        previewFormat: null,
        allowFreeText: false,
      },
    });
  } catch (err) {
    threw = true;
    expect(/Codex runtime cannot emit/.test(err.message), `codex sender rejected with expected message (${err.message})`);
  }
  expect(threw, "codex sender threw on sendMessage");

  const rows = await app.db
    .select()
    .from(sharedDbSchema.pendingQuestions)
    .where(eq(sharedDbSchema.pendingQuestions.id, correlationId));
  expect(rows.length === 0, "no pending row leaked through codex defense");
}

// ── 3. archiveSession supersede path ──
console.log("\n[e2e-askuser] case 3: archiveSession marks pending question superseded");
{
  const ctx = await bootstrapUser();
  const peer = await createAgent(
    app.db,
    {
      name: `e2e-arc-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Archive Peer",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    },
    { force: true },
  );
  const chat = await createChat(app.db, ctx.humanAgent.uuid, {
    type: "direct",
    participantIds: [peer.uuid],
  });
  const correlationId = `tu_arc_${randomUUID().slice(0, 8)}`;
  await sendMessage(app.db, chat.id, peer.uuid, {
    format: "question",
    content: {
      correlationId,
      questions: [
        {
          question: "Continue?",
          header: "Cont?",
          options: [
            { label: "Yes", description: "", preview: null },
            { label: "No", description: "", preview: null },
          ],
          multiSelect: false,
        },
      ],
      previewFormat: null,
      allowFreeText: false,
    },
  });

  await app.db
    .insert(sharedDbSchema.agentChatSessions)
    .values({ agentId: peer.uuid, chatId: chat.id, state: "active" })
    .onConflictDoUpdate({
      target: [sharedDbSchema.agentChatSessions.agentId, sharedDbSchema.agentChatSessions.chatId],
      set: { state: "active", updatedAt: new Date() },
    });
  await suspendSession(app.db, peer.uuid, chat.id, peer.organizationId);
  await archiveSession(app.db, peer.uuid, chat.id, peer.organizationId);

  const [row] = await app.db
    .select()
    .from(sharedDbSchema.pendingQuestions)
    .where(eq(sharedDbSchema.pendingQuestions.id, correlationId))
    .limit(1);
  expect(row?.status === "superseded", "archiveSession superseded the pending question");
  expect(row?.supersededReason === "chat_archived", "supersede reason = chat_archived");

  // Posting an answer on a superseded question must return 409.
  const lateRes = await inject(
    "POST",
    `/api/v1/chats/${chat.id}/questions/${correlationId}/answer`,
    ctx.accessToken,
    { answers: { "Continue?": "Yes" } },
  );
  expect(lateRes.statusCode === 409, `late answer on superseded returns 409 (got ${lateRes.statusCode})`);
}

// ── 4. claimClient supersede path ──
console.log("\n[e2e-askuser] case 4: claimClient marks pending superseded for unpinned agents");
{
  const ctx = await bootstrapUser();
  const peer = await createAgent(
    app.db,
    {
      name: `e2e-claim-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Claim Peer",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    },
    { force: true },
  );
  const chat = await createChat(app.db, ctx.humanAgent.uuid, {
    type: "direct",
    participantIds: [peer.uuid],
  });
  const correlationId = `tu_claim_${randomUUID().slice(0, 8)}`;
  await sendMessage(app.db, chat.id, peer.uuid, {
    format: "question",
    content: {
      correlationId,
      questions: [
        {
          question: "Pick one",
          header: "Pick",
          options: [
            { label: "A", description: "", preview: null },
            { label: "B", description: "", preview: null },
          ],
          multiSelect: false,
        },
      ],
      previewFormat: null,
      allowFreeText: false,
    },
  });

  // New owner takes over the client.
  const newOwnerId = uuidv7();
  await app.db.insert(sharedDbSchema.users).values({
    id: newOwnerId,
    username: `e2e-newowner-${randomUUID().slice(0, 6)}`,
    passwordHash: "$2b$04$" + "x".repeat(22) + "y".repeat(31),
    displayName: "New Owner",
  });
  await app.db.insert(sharedDbSchema.members).values({
    id: uuidv7(),
    userId: newOwnerId,
    organizationId: ctx.organizationId,
    agentId: peer.uuid, // not used for the claim, just satisfies the schema
    role: "admin",
  });

  const claimResult = await claimClient(app.db, ctx.clientId, newOwnerId);
  expect(claimResult.unpinnedAgentIds.includes(peer.uuid), "claim unpinned the affected agent");

  const [row] = await app.db
    .select()
    .from(sharedDbSchema.pendingQuestions)
    .where(eq(sharedDbSchema.pendingQuestions.id, correlationId))
    .limit(1);
  expect(row?.status === "superseded", "claimClient superseded the pending question");
  expect(row?.supersededReason === "client_claimed", "supersede reason = client_claimed");
}

// ── 5. Client-side bridge dispatch — drives the real session-manager
//      short-circuit that resolves a `canUseTool` Promise from a real
//      `format=question_answer` inbox entry. ──
console.log("\n[e2e-askuser] case 5: client bridge resolves on inbox question_answer");
{
  const { registerPendingQuestion, tryResolveQuestionAnswer, pendingQuestionCount, clearAllPendingQuestionsForTest } =
    await import("../../client/src/handlers/ask-user-bridge.ts");
  clearAllPendingQuestionsForTest();

  const correlationId = `tu_bridge_${randomUUID().slice(0, 8)}`;
  const waiter = registerPendingQuestion({
    correlationId,
    agentId: "e2e-agent",
    chatId: "e2e-chat",
  });
  expect(pendingQuestionCount() === 1, "bridge registered the pending question");

  // This is exactly the body session-manager.dispatch passes when a
  // `format=question_answer` inbox entry arrives. Round-trip the wire shape.
  const matched = tryResolveQuestionAnswer({
    correlationId,
    answers: { foo: "bar" },
  });
  expect(matched, "bridge accepted the matching answer");

  const result = await Promise.race([
    waiter,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000)),
  ]);
  expect(result?.status === "answered", "waiter resolved as answered");
  expect(result?.answers?.foo === "bar", "waiter received answers verbatim");
  expect(pendingQuestionCount() === 0, "bridge cleaned up after resolve");
}

// ── 6. Inbox poll round-trip — proves the agent client would actually receive
//      the `format=question_answer` message via its existing pollInbox
//      contract (SessionManager.dispatch's input source). ──
console.log("\n[e2e-askuser] case 6: agent inbox.pull surfaces question_answer entry");
{
  const { pollInbox } = await import("../src/services/inbox.ts");
  const ctx = await bootstrapUser();
  const peer = await createAgent(
    app.db,
    {
      name: `e2e-poll-${randomUUID().slice(0, 6)}`,
      type: "autonomous_agent",
      displayName: "Poll Peer",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    },
    { force: true },
  );
  const chat = await createChat(app.db, ctx.humanAgent.uuid, {
    type: "direct",
    participantIds: [peer.uuid],
  });
  const correlationId = `tu_poll_${randomUUID().slice(0, 8)}`;
  await sendMessage(app.db, chat.id, peer.uuid, {
    format: "question",
    content: {
      correlationId,
      questions: [
        {
          question: "Ship it?",
          header: "Ship?",
          options: [
            { label: "Yes", description: "", preview: null },
            { label: "No", description: "", preview: null },
          ],
          multiSelect: false,
        },
      ],
      previewFormat: null,
      allowFreeText: false,
    },
  });

  await inject(
    "POST",
    `/api/v1/chats/${chat.id}/questions/${correlationId}/answer`,
    ctx.accessToken,
    { answers: { "Ship it?": "Yes" } },
  );

  // The peer agent's inbox should now hold the answer message — exactly
  // what SessionManager.dispatch would receive via WS push or HTTP poll.
  const polled = await pollInbox(app.db, peer.inboxId, 10);
  const answerEntry = polled.find((e) => e.message?.format === "question_answer");
  expect(answerEntry !== undefined, "agent inbox poll returns the question_answer entry");
  expect(answerEntry?.message?.content?.correlationId === correlationId, "polled answer's correlationId roundtrips");
  expect(
    answerEntry?.message?.content?.answers?.["Ship it?"] === "Yes",
    "polled answer carries the user's selected option",
  );
}

await app.close();

if (failures.length > 0) {
  console.log(`\n[e2e-askuser] ✗ ${failures.length} failures:`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log("\n[e2e-askuser] ✓ all assertions passed");
process.exit(0);
