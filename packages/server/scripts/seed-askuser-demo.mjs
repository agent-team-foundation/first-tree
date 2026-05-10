// Seed the e2e DB with the canonical "Dev: skip GitHub" user (login=devuser,
// githubId=1 — matches the hardcoded login.tsx button), a personal team,
// one Claude-runtime peer agent, a direct chat, and a single pending
// `format=question` message — so the operator can click the dev-OAuth
// button on the running web UI and immediately land on a chat with the
// question card on screen.
//
// Mirrors what `/api/v1/auth/github/dev-callback` would create on first
// sign-in (findOrCreateUserFromGithub + createPersonalTeam) so that
// clicking the dev button after this seed lands on the existing user
// instead of provisioning a fresh one.

import { randomUUID } from "node:crypto";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const { buildApp } = await import("../src/app.ts");
const { sendMessage } = await import("../src/services/message.ts");
const { createAgent } = await import("../src/services/agent.ts");
const { createChat } = await import("../src/services/chat.ts");
const { ensureDefaultOrganization } = await import("../src/services/organization.ts");
const { findOrCreateUserFromGithub } = await import("../src/services/auth-identity.ts");
const { createPersonalTeam } = await import("../src/services/membership.ts");
const sharedDbSchema = await import("../src/db/schema/index.ts");
const { sql: drizzleSql, eq } = await import("drizzle-orm");

const JWT_SECRET = process.env.JWT_SECRET_KEY ?? process.env.JWT_SECRET ?? "demo-jwt-secret";

const config = {
  database: { url: DB_URL, provider: "external" },
  server: { port: 0, host: "127.0.0.1", publicUrl: undefined },
  secrets: {
    jwtSecret: JWT_SECRET,
    encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
  auth: { accessTokenExpiry: "30m", refreshTokenExpiry: "30d", connectTokenExpiry: "10m" },
  github: { webhookSecret: "demo-webhook", allowedOrg: "demo" },
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
  instanceId: "seed-demo",
};

const app = await buildApp(config);
await app.ready();

await app.db.execute(
  drizzleSql.raw(`
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
`),
);
await ensureDefaultOrganization(app.db);

// Match the hardcoded login.tsx dev-callback href:
//   /api/v1/auth/github/dev-callback?githubId=1&login=devuser&displayName=Dev+User
// findOrCreateUserFromGithub creates the users + auth_identities rows;
// createPersonalTeam creates the org + members row. After this seed,
// clicking the "Dev: skip GitHub" button on the login page lands on the
// existing user instead of provisioning a fresh one.
const githubProfile = {
  githubId: "1",
  login: "devuser",
  email: null,
  displayName: "Dev User",
  avatarUrl: null,
};
const { userId } = await findOrCreateUserFromGithub(app.db, githubProfile);
const team = await createPersonalTeam(app.db, {
  userId,
  loginSeed: githubProfile.login,
  userDisplayName: githubProfile.displayName,
});
const orgId = team.organizationId;
const memberId = team.memberId;

// `createPersonalTeam` already provisioned the human agent for this user
// (via ensureMembership). Look it up so we can build a chat with the peer
// in the same org.
const [memberRow] = await app.db
  .select({ agentId: sharedDbSchema.members.agentId })
  .from(sharedDbSchema.members)
  .where(eq(sharedDbSchema.members.id, memberId))
  .limit(1);
const humanAgentId = memberRow?.agentId;
if (!humanAgentId) throw new Error("expected member to carry an agentId");

const clientId = `cli-demo-${randomUUID().slice(0, 6)}`;
await app.db.insert(sharedDbSchema.clients).values({
  id: clientId,
  userId,
  organizationId: orgId,
  status: "connected",
});

const peer = await createAgent(
  app.db,
  {
    name: "demo-claude-bot",
    type: "autonomous_agent",
    displayName: "Claude Demo Bot",
    managerId: memberId,
    clientId,
    runtimeProvider: "claude-code",
  },
  { force: true },
);

const chat = await createChat(app.db, humanAgentId, {
  type: "direct",
  participantIds: [peer.uuid],
});

// Pending single-select question with HTML preview — exercises the
// DOMPurify + option-card path.
const correlationId = `tu_demo_${randomUUID().slice(0, 8)}`;
await sendMessage(app.db, chat.id, peer.uuid, {
  format: "question",
  content: {
    correlationId,
    questions: [
      {
        question: "How should I handle the upcoming migration?",
        header: "Migration",
        options: [
          {
            label: "Rebase",
            description: "Replay our commits on top of main — cleaner history.",
            preview:
              '<div style="font-family: monospace; padding: 8px;"><strong>git rebase main</strong><br/><small style="color: #666;">Replays N commits on top of main</small></div>',
          },
          {
            label: "Merge",
            description: "Merge main into our branch — preserves the merge graph.",
            preview:
              '<div style="font-family: monospace; padding: 8px;"><strong>git merge main</strong><br/><small style="color: #666;">Single merge commit, branch graph preserved</small></div>',
          },
          {
            label: "Squash",
            description: "Squash our commits into one before merging.",
            preview:
              '<div style="font-family: monospace; padding: 8px;"><strong>git merge --squash main</strong><br/><small style="color: #666;">Collapses N commits into a single change</small></div>',
          },
        ],
        multiSelect: false,
      },
      {
        question: "Should I run the test suite before pushing?",
        header: "Tests?",
        options: [
          { label: "Yes — full suite", description: "Run pnpm test (slow but safe).", preview: null },
          { label: "Yes — only changed packages", description: "Faster but narrower coverage.", preview: null },
          { label: "Skip", description: "Push without local verification.", preview: null },
        ],
        multiSelect: false,
      },
    ],
    previewFormat: "html",
    allowFreeText: true,
  },
});

await app.close();

const PORT = process.env.PORT ?? "8000";
console.log("\n[seed-askuser-demo] ✓ seeded demo data");
console.log("");
console.log(`  Login URL:    http://localhost:${PORT}/login`);
console.log(`  Login flow:   click "Dev: skip GitHub" (localhost-only button)`);
console.log(`  GitHub login: devuser (githubId=1)`);
console.log(`  Org:          ${team.slug} (${team.displayName})`);
console.log(`  Chat ID:      ${chat.id}`);
console.log(`  Peer agent:   ${peer.uuid} (${peer.name})`);
console.log(`  Question id:  ${correlationId}`);
console.log("");
console.log("After login, open the chat with 'Claude Demo Bot' to see two pending question cards.");
