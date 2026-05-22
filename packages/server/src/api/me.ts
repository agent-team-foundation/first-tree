import {
  createOrgFromMeSchema,
  joinByInvitationSchema,
  type OnboardingStep,
  onboardingEventSchema,
  patchOnboardingSchema,
} from "@first-tree/shared";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agents } from "../db/schema/agents.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { NotFoundError } from "../errors.js";
import { requireUser } from "../scope/require-user.js";
import { listAgentsManagedByUser } from "../services/access-control.js";
import { resolveAvatarImageUrl } from "../services/agent.js";
import * as authService from "../services/auth.js";
import * as clientService from "../services/client.js";
import { COMMAND_PACKAGE_NAME } from "../services/command-version-poller.js";
import { decryptValue, encryptValue } from "../services/crypto.js";
import { GithubAppApiError, refreshAppUserToken } from "../services/github-app.js";
import { GithubApiError, listUserRepos } from "../services/github-oauth.js";
import { buildInviteUrl, findActiveByToken, getActiveInvitation, recordRedemption } from "../services/invitation.js";
import {
  countActiveMembersByOrgs,
  ensureMembership,
  leaveOrganization,
  listActiveMemberships,
  selfCreateOrganization,
} from "../services/membership.js";
import { resolvePublicUrl } from "../utils/public-url.js";
import { serializeDate } from "../utils.js";

/**
 * `/me` and self-service organization routes (Class A — User-scoped).
 * Mounted under `requireUser` so the JWT only needs `sub = userId`.
 *
 * The web client picks the "currently selected org" from
 * `localStorage.selectedOrganizationId`; this response surfaces a
 * `defaultOrganizationId` to seed that selector on first login (and as a
 * fallback when localStorage is wiped).
 */
export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (request) => {
    const { userId } = requireUser(request);

    const [user] = await app.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        onboardingDismissedAt: users.onboardingDismissedAt,
        onboardingCompletedAt: users.onboardingCompletedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const memberships = await listActiveMemberships(app.db, userId);
    const defaultMembership = authService.pickDefaultMembership(
      memberships.map((m) => ({ id: m.memberId, createdAt: m.createdAt })),
    );
    const defaultOrgId = defaultMembership
      ? (memberships.find((m) => m.memberId === defaultMembership.id)?.organizationId ?? null)
      : null;

    // One COUNT(*)/GROUP BY for every org the caller belongs to. The web
    // onboarding gate keys off "does this team have anyone other than me"
    // (replaces sessionStorage `joinPath`, which leaks between tabs/devices).
    // Default to 1 on a missing row so a transient race never spuriously
    // flips the "team-of-teammates" copy on.
    const memberCounts = await countActiveMembersByOrgs(
      app.db,
      memberships.map((mb) => mb.organizationId),
    );

    // Surface invite URL only for users who admin at least one org. The
    // web client picks the relevant org from `selectedOrganizationId`
    // first; this is purely a convenience fallback for the default org.
    let inviteUrl: string | null = null;
    if (defaultOrgId) {
      const defaultRow = memberships.find((m) => m.organizationId === defaultOrgId);
      if (defaultRow?.role === "admin") {
        const inv = await getActiveInvitation(app.db, defaultOrgId);
        if (inv) inviteUrl = buildInviteUrl(resolvePublicUrl(app, request), inv.token);
      }
    }

    const onboardingStep = await inferOnboardingStep(app, userId);

    return {
      user: user ?? null,
      defaultOrganizationId: defaultOrgId,
      memberships: memberships.map((mb) => ({
        id: mb.memberId,
        organizationId: mb.organizationId,
        organizationName: mb.orgDisplayName,
        role: mb.role,
        agentId: mb.agentId,
        orgHasOtherMembers: (memberCounts.get(mb.organizationId) ?? 1) > 1,
      })),
      onboarding: {
        step: onboardingStep,
        dismissedAt: user?.onboardingDismissedAt ? user.onboardingDismissedAt.toISOString() : null,
        completedAt: user?.onboardingCompletedAt ? user.onboardingCompletedAt.toISOString() : null,
      },
      inviteUrl,
    };
  });

  /**
   * PATCH /me/onboarding — currently the only mutable field is
   * `dismissed`, set when the user clicks `✕` on the onboarding stepper.
   * Stamping NOW() server-side avoids client-clock skew. Idempotent: a
   * second PATCH leaves the original timestamp in place.
   *
   * See docs/new-user-onboarding-design.md §8.4.
   */
  app.patch("/me/onboarding", async (request, reply) => {
    const { userId } = requireUser(request);
    const body = patchOnboardingSchema.parse(request.body);

    if (body.dismissed === true) {
      // Only stamp when not already set — re-clicks become a no-op rather
      // than resetting the original dismissal time.
      const result = await app.db
        .update(users)
        .set({ onboardingDismissedAt: new Date() })
        .where(and(eq(users.id, userId), isNull(users.onboardingDismissedAt)))
        .returning({ id: users.id });
      if (result.length > 0) {
        app.log.info({ event: "onboarding.dismissed", userId }, "onboarding funnel: stepper dismissed");
      }
    } else if (body.dismissed === false) {
      await app.db.update(users).set({ onboardingDismissedAt: null }).where(eq(users.id, userId));
    }

    const [u] = await app.db
      .select({ onboardingDismissedAt: users.onboardingDismissedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return reply.status(200).send({
      dismissedAt: u?.onboardingDismissedAt ? u.onboardingDismissedAt.toISOString() : null,
    });
  });

  /**
   * POST /me/onboarding-completed — stamp the terminal-state column when
   * the user walks Step 3 to success (admin Continue, invitee Confirm /
   * Continue). Distinct from PATCH /me/onboarding { dismissed: true },
   * which only hides the stepper UI. Once stamped, the web sidebar drops
   * the Settings → Onboarding entry point and /settings/onboarding
   * redirects, so the wizard cannot re-enter.
   *
   * Idempotent: only writes when the column is still NULL — re-calling on
   * an already-completed user is a no-op rather than resetting the stamp.
   */
  app.post("/me/onboarding-completed", async (request, reply) => {
    const { userId } = requireUser(request);
    const result = await app.db
      .update(users)
      .set({ onboardingCompletedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.onboardingCompletedAt)))
      .returning({ id: users.id });
    if (result.length > 0) {
      app.log.info({ event: "onboarding.completed", userId }, "onboarding funnel: setup completed");
    }
    return reply.status(200).send({ ok: true });
  });

  /**
   * POST /me/onboarding/events — web-side onboarding funnel reporter.
   * Server-side milestones (`team_created` at OAuth, `dismissed` on PATCH)
   * are emitted directly; this endpoint surfaces the web-driven ones into
   * the same log stream so a single funnel query covers the full flow.
   * Body shape is enum-validated so the server won't log arbitrary names.
   *
   * Rate-limited to keep a buggy or hostile authenticated tab from
   * flooding the log stream. The cap is generous relative to legitimate
   * funnel traffic (≤ 4 events per onboarding pass).
   */
  app.post(
    "/me/onboarding/events",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { userId } = requireUser(request);
      const body = onboardingEventSchema.parse(request.body);
      // Spread client `attrs` FIRST so the trusted server fields below
      // (`event`, `userId`) cannot be overwritten by a hostile caller —
      // `attrs` is a freeform Record<string, primitive> per the schema, so
      // a client could otherwise send `attrs: { event: "...", userId: "..." }`
      // and forge funnel attribution (post-merge codex review #248).
      app.log.info(
        { ...(body.attrs ?? {}), event: `onboarding.${body.event}`, userId },
        `onboarding funnel: ${body.event}`,
      );
      return reply.status(204).send();
    },
  );

  /**
   * GET /me/github/repos — list the caller's accessible GitHub repos. Used
   * by the Step 2 onboarding repo picker. The OAuth access token was
   * captured at sign-in (encrypted at rest in `auth_identities.metadata`)
   * so this endpoint avoids a second redirect.
   *
   * 503 if the user has no GitHub identity bound or the token wasn't
   * captured (e.g. dev-callback sign-in or pre-redesign user). The web
   * client falls back to a "Reconnect GitHub" hint in that case.
   *
   * codex P1-4: GitHub App user-to-server tokens have an ~8h TTL. If
   * the stored `accessTokenExpiresAt` is past (or within a 60-second
   * buffer of expiring), trade in the persisted refresh token for a
   * fresh pair before calling GitHub. Legacy rows without expiry
   * fields fall through unchanged — the never-expiring OAuth-App token
   * still works as-is.
   */
  app.get("/me/github/repos", async (request, reply) => {
    const { userId } = requireUser(request);
    const [identity] = await app.db
      .select({ metadata: authIdentities.metadata })
      .from(authIdentities)
      .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, "github")))
      .limit(1);
    const metadata = identity?.metadata && typeof identity.metadata === "object" ? identity.metadata : null;
    const encrypted =
      metadata && "accessToken" in metadata ? (metadata as { accessToken?: unknown }).accessToken : undefined;
    if (typeof encrypted !== "string" || !encrypted) {
      return reply.status(503).send({ error: "GitHub access token unavailable — please reconnect your account" });
    }
    let token: string;
    try {
      token = decryptValue(encrypted, app.config.secrets.encryptionKey);
    } catch {
      return reply.status(503).send({ error: "GitHub access token could not be decoded — please reconnect" });
    }

    // Refresh-on-expiry: only attempt when the row carries the
    // App-flavoured expiry fields. Legacy (pre-App) rows have only
    // `accessToken` — those tokens don't expire, so skip refresh.
    const appCfg = app.config.oauth?.githubApp;
    const expiresAtRaw =
      metadata && "accessTokenExpiresAt" in metadata
        ? (metadata as { accessTokenExpiresAt?: unknown }).accessTokenExpiresAt
        : undefined;
    const encryptedRefresh =
      metadata && "refreshToken" in metadata ? (metadata as { refreshToken?: unknown }).refreshToken : undefined;
    if (typeof expiresAtRaw === "string" && typeof encryptedRefresh === "string" && encryptedRefresh && appCfg) {
      const expiresAt = Date.parse(expiresAtRaw);
      // 60-second buffer — refresh slightly early so we don't hit the
      // window where the token is technically still valid but expires
      // mid-request.
      if (!Number.isNaN(expiresAt) && expiresAt - 60_000 <= Date.now()) {
        try {
          const refreshPlain = decryptValue(encryptedRefresh, app.config.secrets.encryptionKey);
          const refreshed = await refreshAppUserToken(appCfg.clientId, appCfg.clientSecret, refreshPlain);
          // Persist the new pair so subsequent calls don't re-refresh.
          // GitHub rotates the refresh token on every refresh — using
          // the old one after this point is `bad_refresh_token`.
          const nextMetadata: Record<string, unknown> = {
            ...(metadata ?? {}),
            accessToken: encryptValue(refreshed.accessToken, app.config.secrets.encryptionKey),
            accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
            refreshToken: encryptValue(refreshed.refreshToken, app.config.secrets.encryptionKey),
            refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
          };
          await app.db
            .update(authIdentities)
            .set({ metadata: nextMetadata, updatedAt: new Date() })
            .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, "github")));
          token = refreshed.accessToken;
        } catch (err) {
          // Refresh failure → caller gets the same "please reconnect"
          // 503 the legacy paths return. We DON'T fall back to the
          // expired token because GitHub will reject it anyway and
          // the user's experience is just a slightly slower 403.
          app.log.warn({ err, userId }, "github app user-token refresh failed");
          const status = err instanceof GithubAppApiError ? err.status : 503;
          if (status === 401) {
            return reply.status(403).send({
              error: "Your GitHub session has expired. Please sign in again.",
              code: "refresh_failed",
            });
          }
          return reply
            .status(503)
            .send({ error: "Couldn't refresh GitHub credentials. Try again, or reconnect your GitHub account." });
        }
      }
    }

    try {
      const repos = await listUserRepos(token);
      return { repos };
    } catch (err) {
      // Don't echo GitHub's raw error string back to the client — a 401
      // ("Bad credentials") would leak token-revocation hints. Log the
      // real error server-side, return a stable copy.
      app.log.warn({ err, userId }, "list github repos failed");
      // Auth failures (401 / 403) typically mean the stored token is stale
      // or — more commonly post-`repo`-scope-expansion — was minted without
      // the `repo` scope. Return 403 with `code: scope_missing` so the web
      // RepoPicker surfaces the "Reconnect GitHub" path on the first call
      // rather than after a confusing 502.
      if (err instanceof GithubApiError && (err.status === 401 || err.status === 403)) {
        return reply.status(403).send({
          error: "GitHub access token is missing the `repo` scope. Please reconnect your GitHub account.",
          code: "scope_missing",
        });
      }
      return reply.status(502).send({ error: "Couldn't reach GitHub. Try again, or reconnect your GitHub account." });
    }
  });

  /**
   * POST /me/connect-tokens — short-lived connect token for the CLI.
   * The token now carries only `sub = userId`; the CLI rejoins via
   * `exchangeConnectToken` which probes `members` realtime.
   */
  const loginMax = app.config.rateLimit?.loginMax ?? 5;
  app.post(
    "/me/connect-tokens",
    { config: { rateLimit: { max: loginMax, timeWindow: "1 minute" } } },
    async (request) => {
      const { userId } = requireUser(request);
      const issuer = resolvePublicUrl(app, request);
      const { token, expiresIn } = await authService.generateConnectToken(
        userId,
        app.config.secrets.jwtSecret,
        app.config.auth,
        issuer,
      );
      // Channel-aware npm spec. Web onboarding renders the returned
      // `bootstrapCommand` directly so a fresh-machine install lands on
      // the version this Hub actually advertises — without it, staging
      // (channel=alpha) users `npm i -g …` land on stable, then watch
      // auto-update yank them up to alpha 30s later (which used to be
      // exactly the cross-edge scenario that bricked their service
      // unit). `latest` is npm's default dist-tag so we keep the bare
      // spec for prod; only non-latest channels get the `@<tag>` suffix.
      const channel = app.config.update.channel;
      const npmSpec = channel === "latest" ? COMMAND_PACKAGE_NAME : `${COMMAND_PACKAGE_NAME}@${channel}`;
      const command = `first-tree login ${token}`;
      const bootstrapCommand = `npm install -g ${npmSpec}\n${command}`;
      return { token, expiresIn, command, bootstrapCommand, npmSpec };
    },
  );

  /**
   * GET /me/managed-agents — cross-org list of every agent the caller
   * personally manages. Powers the CLI `agent list --remote` view.
   */
  app.get("/me/managed-agents", async (request) => {
    const { userId } = requireUser(request);
    const rows = await listAgentsManagedByUser(app.db, userId);
    return rows.map((r) => ({
      uuid: r.uuid,
      name: r.name,
      displayName: r.displayName,
      type: r.type,
      organizationId: r.organizationId,
      inboxId: r.inboxId,
      visibility: r.visibility,
      runtimeProvider: r.runtimeProvider,
      clientId: r.clientId,
      // Resolved avatar URL — uploaded image takes priority; for human
      // agents falls back to the backing user's external (GitHub) URL.
      // Lets the web client render cross-org human avatars in chat
      // surfaces, since `useAgentIdentityMap` merges this list with the
      // org-scoped `/agents` source.
      avatarImageUrl: resolveAvatarImageUrl({
        uuid: r.uuid,
        type: r.type,
        avatarImageUpdatedAt: r.avatarImageUpdatedAt,
        userAvatarUrl: r.userAvatarUrl,
      }),
    }));
  });

  /**
   * GET /me/pinned-agents — every agent pinned to a client owned by the
   * caller's user. Used by the SDK reconcile layer to authoritatively map
   * `agents.runtime_provider` before spawning handlers.
   */
  app.get("/me/pinned-agents", async (request) => {
    const { userId } = requireUser(request);
    const { listMyPinnedAgents } = await import("../services/client.js");
    return listMyPinnedAgents(app.db, { userId });
  });

  /**
   * GET /me/clients — cross-org list of every client owned by the caller.
   * A client is owned by exactly one user (clients.user_id) and the same
   * machine can carry agents from any org the user belongs to, so this
   * surface is org-agnostic — Class A by the decision tree in
   * `docs/http-path-conventions.md`. Powers Settings → Computers in the
   * web UI; the org-admin audit view (`/orgs/:orgId/clients`) stays for
   * a future "team device audit" surface.
   */
  app.get("/me/clients", async (request) => {
    const { userId } = requireUser(request);
    const list = await clientService.listClients(app.db, { userId });
    const refreshExpirySeconds = authService.expiryToSeconds(app.config.auth.refreshTokenExpiry);
    return list.map((c) => ({
      id: c.id,
      userId: c.userId,
      status: c.status,
      authState: clientService.deriveAuthState(c, refreshExpirySeconds),
      sdkVersion: c.sdkVersion,
      hostname: c.hostname,
      os: c.os,
      agentCount: c.agentCount,
      connectedAt: serializeDate(c.connectedAt),
      lastSeenAt: c.lastSeenAt.toISOString(),
      lastUpdateAttempt: clientService.extractLastUpdateAttempt(c.metadata),
    }));
  });

  // ── Self-service org management ──────────────────────────────────────────

  app.get("/me/organizations", async (request) => {
    const { userId } = requireUser(request);
    const rows = await listActiveMemberships(app.db, userId);
    return rows.map((r) => ({
      id: r.organizationId,
      name: r.orgName,
      displayName: r.orgDisplayName,
      role: r.role,
    }));
  });

  app.post("/me/organizations", { config: { otelRecordBody: true } }, async (request, reply) => {
    const { userId } = requireUser(request);
    const body = createOrgFromMeSchema.parse(request.body);

    const [u] = await app.db
      .select({ username: users.username, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!u) throw new NotFoundError("User not found");

    const created = await selfCreateOrganization(app.db, {
      userId,
      userDisplayName: u.displayName,
      username: u.username,
      name: body.name,
      displayName: body.displayName,
    });
    // Token reuse: signing-then-returning would just produce the same
    // user-only token the caller already holds. Skip the round-trip.
    return reply.status(201).send({
      organization: {
        id: created.organizationId,
        name: created.name,
        displayName: created.displayName,
        role: "admin" as const,
      },
    });
  });

  app.post(
    "/me/organizations/join",
    { config: { rateLimit: { max: loginMax, timeWindow: "1 minute" }, otelRecordBody: true } },
    async (request, reply) => {
      const { userId } = requireUser(request);
      const body = joinByInvitationSchema.parse(request.body);

      const inv = await findActiveByToken(app.db, body.token);
      if (!inv) {
        return reply.status(404).send({ error: "Invitation not found or no longer valid" });
      }

      const [u] = await app.db
        .select({ username: users.username, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!u) throw new NotFoundError("User not found");

      const member = await ensureMembership(app.db, {
        userId,
        organizationId: inv.organizationId,
        role: inv.role === "admin" ? "admin" : "member",
        displayName: u.displayName,
        username: u.username,
      });
      await recordRedemption(app.db, {
        invitationId: inv.id,
        userId,
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });

      return reply.status(200).send({
        organizationId: member.organizationId,
        memberId: member.id,
        role: member.role,
      });
    },
  );

  app.post<{ Params: { memberId: string } }>("/me/memberships/:memberId/leave", async (request, reply) => {
    const { userId } = requireUser(request);
    // Confirm the member row belongs to the caller before flipping it.
    const [row] = await app.db
      .select({ id: members.id, userId: members.userId })
      .from(members)
      .where(eq(members.id, request.params.memberId))
      .limit(1);
    if (!row || row.userId !== userId) {
      throw new NotFoundError(`Membership "${request.params.memberId}" not found`);
    }
    await leaveOrganization(app.db, row.id);
    return reply.status(204).send();
  });

  /**
   * GET /me/onboarding-step — bare endpoint for clients that don't want the
   * full /me payload. Same logic as inferOnboardingStep below.
   */
  app.get("/me/onboarding-step", async (request) => {
    const { userId } = requireUser(request);
    const step = await inferOnboardingStep(app, userId);
    return { step };
  });
}

/**
 * Infer the onboarding step from the *user-level* facts:
 *   - has at least one client → past "connect"
 *   - manages at least one non-human active agent (any org) → past "create_agent"
 *
 * Critically: the join from agents → members → userId means a user with
 * memberships across multiple orgs has onboarding satisfied as soon as ANY
 * org has a non-human agent — matching the user-level mental model.
 */
async function inferOnboardingStep(app: FastifyInstance, userId: string): Promise<OnboardingStep> {
  const [hasClient] = await app.db.select({ id: clients.id }).from(clients).where(eq(clients.userId, userId)).limit(1);
  if (!hasClient) return "connect";

  const [hasAgent] = await app.db
    .select({ uuid: agents.uuid })
    .from(agents)
    .innerJoin(members, eq(members.id, agents.managerId))
    .where(
      and(
        eq(members.userId, userId),
        eq(members.status, "active"),
        ne(agents.type, "human"),
        eq(agents.status, "active"),
      ),
    )
    .limit(1);
  if (!hasAgent) return "create_agent";
  return "completed";
}
