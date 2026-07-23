import type { AgentType, RuntimeProvider } from "@first-tree/shared";
import { setConfig } from "@first-tree/shared/config";
import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll } from "vitest";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { users } from "../db/schema/users.js";
import { createAgent } from "../services/agent.js";
import { signTokensForUser } from "../services/auth.js";
import { resolveDefaultOrgId } from "../services/organization.js";
import { uuidv7 } from "../uuid.js";

/**
 * Reusable password-hash placeholder for tests that need a `users` row but
 * don't exercise the password-login path. Real bcrypt hashes are pricey to
 * generate per-test (cost factor 4 → ~5ms each); this placeholder is the
 * canonical bcrypt $2b$ format with a 22-byte salt + 31-byte hash so any
 * future bcrypt upgrade that tightens input validation still accepts it.
 * `bcrypt.compare(anything, this)` returns false (intended) without
 * throwing.
 */
export const INVALID_BCRYPT_PLACEHOLDER = `$2b$04$${"x".repeat(22)}${"y".repeat(31)}`;

const DEFAULT_TEST_PASSWORD = "testpassword123";
const TEST_JWT_SECRET = "test-jwt-secret-key-for-vitest";

/**
 * Cache the bcrypt hash for the default test password so we only pay the
 * (cost-factor-1, ~20ms) hashing cost once per worker process. Tests that
 * pass a custom password still hash inline.
 */
let defaultPasswordHash: Promise<string> | undefined;
function hashTestPassword(password: string): Promise<string> {
  if (password !== DEFAULT_TEST_PASSWORD) return bcrypt.hash(password, 1);
  if (!defaultPasswordHash) defaultPasswordHash = bcrypt.hash(password, 1);
  return defaultPasswordHash;
}

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

type AgentRequestFn = (
  method: string,
  url: string,
  payload?: unknown,
  extraHeaders?: Record<string, string>,
) => Promise<InjectResponse>;

/**
 * Optional overrides for `createTestApp` / `useTestApp`. The default config
 * sets rate-limit caps to 10000 so existing tests never trip them; tests that
 * specifically exercise limiter behavior override `max` down to a small
 * number to keep the test loop tight.
 */
export type CreateTestAppOptions = {
  channel?: Config["channel"];
  googleOAuth?: boolean;
  githubOAuth?: boolean;
  /** Document review (docloop) routes. Defaults to enabled in tests. */
  docsEnabled?: boolean;
  /** Cron jobs feature kill switch. Defaults to disabled in tests. */
  cronJobsEnabled?: boolean;
  growthLandingPagesEnabled?: boolean;
  landingCampaignServiceUserId?: string;
  landingCampaignServiceOrgId?: string;
  landingCampaignClientId?: string;
  landingCampaignRuntimeProvider?: "codex" | "claude-code";
  landingCampaignMaxAgentTurns?: number;
  landingCampaignMaxEstimatedTokens?: number;
  landingCampaignMaxTrialsPerUserPer24Hours?: number;
  commandVersion?: string;
  rateLimit?: Partial<NonNullable<Config["rateLimit"]>>;
  connectBootstrap?: Config["connectBootstrap"];
  inbox?: Partial<NonNullable<Config["inbox"]>>;
  runtimeHttpTokenEnforcement?: boolean;
  runtimeSwitchFaultInjection?: boolean;
  allowedOrganizationId?: string;
  gitlabEgressAllowlist?: NonNullable<Config["gitlab"]>["egressAllowlist"];
  /**
   * Drop `oauth.githubApp.slug` from the test config. Used by the
   * `/github-app-installation/install-url` 503 test — the slug is the
   * one App field that's optional within the block, so a deployment can
   * have sign-in/webhooks wired but no install URL.
   */
  omitGithubAppSlug?: boolean;
  /**
   * Override `oauth.githubApp.privateKeyPem`. The default is a syntactically
   * valid PKCS#8 header with junk body — `createAppJwt` rejects it. Tests
   * that need the App-JWT path to actually sign (e.g. the
   * `/auth/github/callback` integration tests where the install row is
   * UPSERTed via `fetchInstallation` rather than pre-seeded) generate a
   * throwaway RSA-2048 keypair and pass it in here.
   */
  githubAppPrivateKeyPem?: string;
};

export async function createTestApp(opts: CreateTestAppOptions = {}): Promise<FastifyInstance> {
  const baseRateLimit = {
    max: 10000,
  };
  const config: Config = {
    channel: opts.channel ?? "dev",
    growth: {
      landingPagesEnabled: opts.growthLandingPagesEnabled ?? false,
      landingCampaignMaxAgentTurns: opts.landingCampaignMaxAgentTurns ?? 1,
      landingCampaignMaxEstimatedTokens: opts.landingCampaignMaxEstimatedTokens ?? 120_000,
      landingCampaignMaxTrialsPerUserPer24Hours: opts.landingCampaignMaxTrialsPerUserPer24Hours ?? 5,
      ...(opts.landingCampaignServiceUserId !== undefined ||
      opts.landingCampaignServiceOrgId !== undefined ||
      opts.landingCampaignClientId !== undefined ||
      opts.landingCampaignRuntimeProvider !== undefined
        ? {
            landingCampaigns: {
              serviceUserId: opts.landingCampaignServiceUserId,
              serviceOrgId: opts.landingCampaignServiceOrgId,
              clientId: opts.landingCampaignClientId,
              runtimeProvider: opts.landingCampaignRuntimeProvider ?? "codex",
            },
          }
        : {}),
    },
    docs: {
      // Docloop is off by default in production config but on in tests so
      // the document routes are exercised without per-test wiring.
      enabled: opts.docsEnabled ?? true,
    },
    cronJobs: {
      // Cron jobs default off in production; tests opt in explicitly.
      enabled: opts.cronJobsEnabled ?? false,
    },
    database: {
      url: process.env.DATABASE_URL ?? "",
      provider: "external",
    },
    server: {
      port: 0,
      host: "127.0.0.1",
      publicUrl: undefined,
    },
    workspace: {
      root: "/tmp/first-tree-test-workspaces",
    },
    secrets: {
      jwtSecret: process.env.JWT_SECRET ?? "test-jwt-secret-key-for-vitest",
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    auth: {
      accessTokenExpiry: "30m",
      refreshTokenExpiry: "30d",
      connectTokenExpiry: "10m",
    },
    gitlab: {
      egressAllowlist:
        opts.gitlabEgressAllowlist ??
        [
          "gitlab.com",
          "gitlab.current",
          "gitlab.customer",
          "gitlab.duplicate",
          "gitlab.example",
          "gitlab.internal",
          "gitlab.replacement",
          "gitlab.resurrected",
          "gitlab.stale",
        ].map((host) => ({
          origin: `https://${host}`,
          addressPolicy: { kind: "public" as const },
        })),
    },
    ...(opts.allowedOrganizationId !== undefined
      ? { access: { allowedOrganizationId: opts.allowedOrganizationId.trim() || undefined } }
      : {}),
    oauth: {
      ...(opts.googleOAuth
        ? {
            google: {
              clientId: "test-google-client-id",
              clientSecret: "test-google-client-secret",
            },
          }
        : {}),
      // Stub GitHub App creds. Tests that exercise the App flow inject
      // fetchers / mocks at the service-call layer and never actually
      // consume these values — see github-app.test.ts.
      // `privateKeyPem` must contain the BEGIN PRIVATE KEY header — the
      // boot guard now runs from `buildApp` (codex P1-8 fix), so the
      // test path exercises it. Body is junk; we never sign with it.
      githubApp: {
        appId: "test-app-id",
        clientId: "test-app-client-id",
        clientSecret: "test-app-client-secret",
        privateKeyPem:
          opts.githubAppPrivateKeyPem ??
          "-----BEGIN PRIVATE KEY-----\nstub-base64-key-body-not-actually-signed\n-----END PRIVATE KEY-----\n",
        webhookSecret: "test-app-webhook-secret",
        slug: opts.omitGithubAppSlug ? undefined : "test-app-slug",
      },
    },
    trustProxy: false,
    connectBootstrap: {
      portableDownloadBaseUrl: "https://download.first-tree.ai/releases",
      ...opts.connectBootstrap,
    },
    rateLimit: { ...baseRateLimit, ...opts.rateLimit },
    ...(opts.inbox !== undefined
      ? { inbox: { maxInFlightPerAgent: 8192, maxInFlightPerAgentChat: 8, ...opts.inbox } }
      : {}),
    observability: {
      logging: { level: "error", format: "json", bridgeToSpanLevel: "off" },
    },
    runtime: {
      agentHttpTokenEnforcement: opts.runtimeHttpTokenEnforcement ?? false,
      runtimeSwitchFaultInjection: opts.runtimeSwitchFaultInjection ?? false,
      pollingIntervalSeconds: 5,
      presenceCleanupSeconds: 60,
      // Disabled by default in tests — suites that exercise the sweeper
      // call it explicitly via `sweepChatArchive`, so the background
      // timer would only add nondeterminism.
      archiveSweepIntervalSeconds: 0,
      archiveMappedIdleSeconds: 60 * 60,
      notificationWebhookUrl: undefined,
    },
    update: {
      // Pin a deterministic version so welcome-frame tests can assert
      // exact equality without coupling to the in-tree package.json.
      commandVersion: opts.commandVersion ?? "test.version",
      // Long enough that the timer never fires inside a test run — we
      // call `refresh()` manually when a test needs a forced poll.
      pollIntervalMinutes: 1440,
      // Point at an unreachable host so a stray refresh during tests
      // logs-and-skips instead of hitting the real npm registry.
      registryUrl: "https://localhost.invalid",
    },
    instanceId: "test-instance",
  };
  if (opts.githubOAuth === false && config.oauth) Reflect.deleteProperty(config.oauth, "githubApp");
  // Pin the singleton so service-layer helpers that go through
  // `getServerCliBinding()` (e.g. message / agent error hints)
  // find a config in-process. Production paths reach this via `initConfig`;
  // test scaffolding bypasses it and builds the Config object manually, so
  // we set the singleton ourselves here.
  setConfig(config);
  const app = await buildApp(config);
  await app.ready();
  return app;
}

/** Lazy test app lifecycle — creates in beforeAll, closes in afterAll. */
export function useTestApp(opts: CreateTestAppOptions = {}) {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await createTestApp(opts);
  });
  afterAll(async () => {
    await app?.close();
  });
  return () => app;
}

/**
 * Create a user + admin member, seed a client row owned by that user, create
 * an agent pinned to that client, and return JWT access token + X-Agent-Id
 * header value. Tests use this helper to hit agent-scoped routes with the
 * unified-user-token middleware chain.
 */
export async function createTestAgent(
  app: FastifyInstance,
  opts: { name?: string; type?: AgentType; displayName?: string } = {},
) {
  const admin = await createTestAdmin(app, { username: `u-${crypto.randomUUID().slice(0, 8)}` });

  const [member] = await app.db.select().from(members).where(eq(members.id, admin.memberId)).limit(1);
  if (!member) throw new Error("admin member missing after setup");
  const clientId = `cli-${crypto.randomUUID().slice(0, 8)}`;
  await app.db.insert(clients).values({
    id: clientId,
    userId: member.userId,
    organizationId: member.organizationId,
    status: "connected",
  });

  const type = opts.type ?? "agent";
  const agent =
    type === "human"
      ? (
          await app.db
            .update(agents)
            .set({
              name: opts.name ?? `test-human-${crypto.randomUUID().slice(0, 8)}`,
              displayName: opts.displayName ?? "Test Human",
              updatedAt: new Date(),
            })
            .where(eq(agents.uuid, admin.humanAgentUuid))
            .returning()
        )[0]
      : await createAgent(app.db, {
          name: opts.name ?? `test-agent-${crypto.randomUUID().slice(0, 8)}`,
          type,
          displayName: opts.displayName ?? "Test Agent",
          managerId: admin.memberId,
          clientId,
        });
  if (!agent) throw new Error("test agent setup failed");

  // `token` is kept as an alias for the user's JWT so the large body of
  // pre-unified-token tests still compiles; those tests will additionally
  // need to send `X-Agent-Id: agent.uuid` at runtime to pass the new
  // middleware chain. The alias is a migration aid, not a permanent API.
  return {
    agent,
    accessToken: admin.accessToken,
    token: admin.accessToken,
    clientId,
    memberId: admin.memberId,
    humanAgentUuid: admin.humanAgentUuid,
    userId: member.userId,
    organizationId: member.organizationId,
    /** Agent-scoped request — adds `Authorization` + `x-agent-id` headers. */
    request: ((method, url, payload, extraHeaders) =>
      app.inject({
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        url,
        headers: {
          authorization: `Bearer ${admin.accessToken}`,
          "x-agent-id": agent.uuid,
          ...extraHeaders,
        },
        ...(payload ? { payload } : {}),
      })) as AgentRequestFn,
  };
}

/**
 * Build an ad-hoc agent-scoped request function from an accessToken + agentId.
 * Useful when the test already has the pieces and doesn't need a fresh agent.
 */
export function agentRequest(app: FastifyInstance, accessToken: string, agentUuid: string): AgentRequestFn {
  return (method, url, payload) =>
    app.inject({
      method: method as "GET" | "POST" | "PATCH" | "DELETE",
      url,
      headers: { authorization: `Bearer ${accessToken}`, "x-agent-id": agentUuid },
      ...(payload ? { payload } : {}),
    });
}

/**
 * Spin up a full create-agent prerequisite chain (admin + client) and return
 * a callable that invokes the service-layer `createAgent` with the pinning
 * defaults pre-filled. Use in unit tests that want to exercise config /
 * lifecycle behavior without re-deriving the admin/client bootstrap each
 * time.
 */
export async function seedAgentFactory(app: FastifyInstance) {
  const admin = await createTestAdmin(app, { username: `seed-${crypto.randomUUID().slice(0, 8)}` });
  const [member] = await app.db.select().from(members).where(eq(members.id, admin.memberId)).limit(1);
  if (!member) throw new Error("seed admin member missing");
  const clientId = `cli-seed-${crypto.randomUUID().slice(0, 8)}`;
  await app.db.insert(clients).values({
    id: clientId,
    userId: member.userId,
    organizationId: member.organizationId,
    status: "connected",
  });

  return async (
    opts: { name?: string; type?: AgentType; displayName?: string; runtimeProvider?: RuntimeProvider } = {},
  ) => {
    return createAgent(app.db, {
      name: opts.name ?? `seed-agent-${crypto.randomUUID().slice(0, 8)}`,
      type: opts.type ?? "agent",
      displayName: opts.displayName ?? "Seed Agent",
      managerId: admin.memberId,
      clientId: opts.type === "human" ? undefined : clientId,
      ...(opts.runtimeProvider ? { runtimeProvider: opts.runtimeProvider } : {}),
    });
  };
}

/** Seed a claimed, connected `clients` row owned by `userId` within `organizationId`. Returns the id. */
export async function seedClient(app: FastifyInstance, userId: string, organizationId: string): Promise<string> {
  const id = `cli-${crypto.randomUUID().slice(0, 8)}`;
  await app.db.insert(clients).values({ id, userId, organizationId, status: "connected" });
  return id;
}

/** Seed the exact live route and install-only capability facts used by runtime health gates. */
export async function seedHealthyAgentRuntime(
  app: FastifyInstance,
  input: {
    agentUuid: string;
    clientId: string;
    runtimeProvider?: RuntimeProvider;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  const runtimeProvider = input.runtimeProvider ?? "claude-code";
  const instanceId = `instance-${input.clientId}`;
  await app.db
    .update(clients)
    .set({
      status: "connected",
      instanceId,
      lastSeenAt: now,
      retiredAt: null,
      pausedReason: null,
      metadata: {
        capabilities: {
          [runtimeProvider]: {
            state: "ok",
            available: true,
            detectedAt: now.toISOString(),
          },
        },
      },
    })
    .where(eq(clients.id, input.clientId));
  await app.db
    .insert(serverInstances)
    .values({ instanceId, lastHeartbeat: now })
    .onConflictDoUpdate({
      target: serverInstances.instanceId,
      set: { lastHeartbeat: now },
    });
  await app.db
    .insert(agentPresence)
    .values({
      agentId: input.agentUuid,
      status: "online",
      clientId: input.clientId,
      instanceId,
      runtimeType: runtimeProvider,
      runtimeState: "idle",
      lastSeenAt: now,
      runtimeUpdatedAt: now,
    })
    .onConflictDoUpdate({
      target: agentPresence.agentId,
      set: {
        status: "online",
        clientId: input.clientId,
        instanceId,
        runtimeType: runtimeProvider,
        runtimeState: "idle",
        lastSeenAt: now,
        runtimeUpdatedAt: now,
      },
    });
}

/**
 * Admin + a seeded client owned by that admin's user. Most test suites need
 * both — non-human agents created by the admin must pin to a client after
 * M1 Rule R-RUN, and tests that call `createAgent` directly need the
 * `clientId` to pass resolveAgentClient's owner check.
 */
export async function createAdminContext(app: FastifyInstance, opts: { username?: string; password?: string } = {}) {
  const admin = await createTestAdmin(app, opts);
  const [member] = await app.db.select().from(members).where(eq(members.id, admin.memberId)).limit(1);
  if (!member) throw new Error("admin member missing after setup");
  const clientId = await seedClient(app, member.userId, member.organizationId);
  return { ...admin, clientId, userId: member.userId, organizationId: member.organizationId };
}

/** Create a user + admin member + human agent and return JWT + memberId. */
export async function createTestAdmin(app: FastifyInstance, opts: { username?: string; password?: string } = {}) {
  const username = opts.username ?? `admin-${crypto.randomUUID().slice(0, 8)}`;
  const password = opts.password ?? DEFAULT_TEST_PASSWORD;
  const passwordHash = await hashTestPassword(password);

  const userId = uuidv7();
  const orgId = await resolveDefaultOrgId(app.db);
  const memberId = uuidv7();

  // agents.manager_id ↔ members.agent_id is a FK cycle; the unified-user-token
  // migration (0019) makes agents.manager_id deferred so both rows can be
  // inserted in one transaction. Mirrors services/member.ts::createMember.
  const agent = await app.db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      username,
      passwordHash,
      displayName: "Test Admin",
    });

    const created = await createAgent(tx as unknown as typeof app.db, {
      name: `test-admin-${crypto.randomUUID().slice(0, 8)}`,
      type: "human",
      displayName: "Test Admin",
      source: "admin-api",
      managerId: memberId,
      organizationId: orgId,
    });

    await tx.insert(members).values({
      id: memberId,
      userId,
      organizationId: orgId,
      agentId: created.uuid,
      role: "admin",
    });

    return created;
  });

  // Skip the `/auth/login` HTTP round-trip. The test app's JWT secret is
  // pinned by createTestApp; signing in-process avoids fastify routing +
  // bcrypt.compare + an extra DB roundtrip per test setup. Tests that
  // explicitly exercise the login path still call `/auth/login` themselves
  // (auth.test.ts, admin-agent-config.test.ts) — they get an *additional*
  // pair of tokens, not the ones we sign here.
  const tokens = await signTokensForUser(TEST_JWT_SECRET, userId, {
    accessTokenExpiry: "30m",
    refreshTokenExpiry: "30d",
  });
  return { username, password, userId, memberId, organizationId: orgId, humanAgentUuid: agent.uuid, ...tokens };
}
