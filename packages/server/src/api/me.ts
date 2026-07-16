import {
  completeOnboardingSchema,
  createOrgFromMeSchema,
  joinByInvitationSchema,
  kickoffOnboardingSchema,
  type OnboardingStep,
  onboardingEventSchema,
  patchOnboardingSchema,
  updateMyProfileSchema,
} from "@first-tree/shared";
import { getChannelConfig } from "@first-tree/shared/channel";
import { and, asc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { NotFoundError } from "../errors.js";
import { requireUser } from "../scope/require-user.js";
import {
  listAgentsManagedByUser,
  listOrgsWithPersonalAgent,
  listOrgsWithUsableNonHumanAgent,
} from "../services/access-control.js";
import { resolveAvatarImageUrl } from "../services/agent.js";
import * as authService from "../services/auth.js";
import * as clientService from "../services/client.js";
import { GithubApiError, listUserRepos } from "../services/github-oauth.js";
import { GithubUserTokenError, getFreshGithubUserToken } from "../services/github-user-token.js";
import { buildInviteUrl, findActiveByToken, getActiveInvitation, recordRedemption } from "../services/invitation.js";
import { isLandingCampaignServiceMembership } from "../services/landing-campaigns/guards.js";
import { updateOwnProfile } from "../services/member.js";
import {
  countActiveMembersByOrgs,
  ensureMembership,
  leaveOrganization,
  listActiveMemberships,
  selfCreateOrganization,
} from "../services/membership.js";
import { notifyRecipients } from "../services/notifier.js";
import {
  campaignActionKickoffKey,
  hasTreeSetupKickoffMessage,
  kickoffOnboarding,
  resolveCampaignActionContext,
} from "../services/onboarding-kickoff.js";
import { getOrgContextTreeWithMeta } from "../services/org-settings.js";
import { resolvePublicUrl } from "../utils/public-url.js";
import { serializeDate } from "../utils.js";
import { clientCommandVersionHint } from "./client-command-version.js";

const onboardingTreeSetupStatusQuerySchema = z.object({
  organizationId: z.string().optional(),
});

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : shellQuote(value);
}

function normalizeDownloadBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeCommandServerUrl(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value.replace(/\/+$/, "");
  }
}

function buildLoginCommand(options: {
  executable: string;
  tokenArg: string;
  serverUrl: string;
  defaultServerUrl: string;
}): string {
  const serverUrl = normalizeCommandServerUrl(options.serverUrl);
  const prefix = serverUrl === options.defaultServerUrl ? "" : `FIRST_TREE_SERVER_URL=${shellQuote(serverUrl)} `;
  return `${prefix}${options.executable} login ${options.tokenArg}`;
}

function buildPortableBootstrapCommand(options: {
  installerUrl: string;
  portableDownloadBaseUrl: string;
  defaultPortableDownloadBaseUrl: string;
  binName: string;
  token: string;
  serverUrl: string;
  defaultServerUrl: string;
}): string {
  const isCustomDownloadBase =
    normalizeDownloadBaseUrl(options.portableDownloadBaseUrl) !==
    normalizeDownloadBaseUrl(options.defaultPortableDownloadBaseUrl);
  const installerUrl = isCustomDownloadBase ? shellQuote(options.installerUrl) : options.installerUrl;
  const installerEnv = isCustomDownloadBase
    ? `FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL=${shellQuote(options.portableDownloadBaseUrl)} `
    : "";
  const loginCommand = buildLoginCommand({
    executable: `~/.local/bin/${options.binName}`,
    tokenArg: shellArg(options.token),
    serverUrl: options.serverUrl,
    defaultServerUrl: options.defaultServerUrl,
  });

  return [`curl -fsSL ${installerUrl} | ${installerEnv}sh`, loginCommand].join("\n");
}

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
    const serviceUserId = app.config.growth.landingCampaigns?.serviceUserId;
    if (serviceUserId && memberships.length > 0) {
      const serviceMemberRows = await app.db
        .select({ userId: members.userId, organizationId: members.organizationId })
        .from(members)
        .where(
          and(
            eq(members.userId, serviceUserId),
            eq(members.status, "active"),
            inArray(
              members.organizationId,
              memberships.map((mb) => mb.organizationId),
            ),
          ),
        );
      for (const row of serviceMemberRows) {
        if (!isLandingCampaignServiceMembership(app.config, row)) continue;
        memberCounts.set(row.organizationId, Math.max(0, (memberCounts.get(row.organizationId) ?? 0) - 1));
      }
    }

    // Org-scoped onboarding readiness: which of the caller's orgs already
    // hold a non-human agent THIS member can use (own or org-visible). The
    // web onboarding gate keys the create-agent step off this per-org bit
    // rather than the account-level `onboardingCompletedAt`, so a returning
    // user who joins a brand-new / all-private org is still walked through
    // creating an agent there. One query for the whole list — no N+1.
    const orgsWithUsableAgent = await listOrgsWithUsableNonHumanAgent(
      app.db,
      memberships.map((mb) => ({ memberId: mb.memberId, organizationId: mb.organizationId })),
    );
    const orgsWithPersonalAgent = await listOrgsWithPersonalAgent(
      app.db,
      memberships.map((mb) => ({ memberId: mb.memberId, organizationId: mb.organizationId })),
    );

    // Surface invite URL only for users who admin at least one org. The
    // web client picks the relevant org from `selectedOrganizationId`
    // first; this is purely a convenience fallback for the default org.
    const defaultRow = defaultOrgId ? memberships.find((m) => m.organizationId === defaultOrgId) : undefined;
    let inviteUrl: string | null = null;
    if (defaultOrgId) {
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
        hasUsableAgent: orgsWithUsableAgent.has(mb.organizationId),
        hasPersonalAgent: orgsWithPersonalAgent.has(mb.organizationId),
        onboardingSuppressedAt: mb.onboardingSuppressedAt ? mb.onboardingSuppressedAt.toISOString() : null,
        onboardingSuppressedReason:
          mb.onboardingSuppressedReason === "finish_later" ||
          mb.onboardingSuppressedReason === "completed" ||
          mb.onboardingSuppressedReason === "invitee_skip"
            ? mb.onboardingSuppressedReason
            : null,
        onboardingCompletedAt: mb.onboardingCompletedAt ? mb.onboardingCompletedAt.toISOString() : null,
      })),
      onboarding: {
        step: onboardingStep,
        dismissedAt: defaultRow?.onboardingSuppressedAt ? defaultRow.onboardingSuppressedAt.toISOString() : null,
        completedAt: defaultRow?.onboardingCompletedAt ? defaultRow.onboardingCompletedAt.toISOString() : null,
      },
      inviteUrl,
      // Deployment-level feature switches the web shell needs before it can
      // decide what to render (e.g. the Context → Documents sub-tab). Server
      // routes stay the enforcement point; this is presentation-only.
      features: {
        docs: app.config.docs.enabled,
      },
    };
  });

  /**
   * PATCH /me/profile — self-service display-name edit. The caller can rename
   * themselves (mirrored to `users.display_name` + every human agent backing
   * their memberships) but cannot change their own role: the schema has no
   * `role` field, so self-promotion is impossible by construction. Admin role
   * changes still go through `PATCH /orgs/:orgId/members/:id`.
   */
  app.patch("/me/profile", async (request) => {
    const { userId } = requireUser(request);
    const { displayName } = updateMyProfileSchema.parse(request.body);
    return updateOwnProfile(app.db, userId, displayName);
  });

  /**
   * PATCH /me/onboarding — set or clear the current membership's auto-open
   * suppressor. `dismissed=true` is the "finish later" action. Stamping
   * NOW() server-side avoids client-clock skew. Idempotent: a second PATCH
   * leaves the original timestamp in place.
   */
  app.patch("/me/onboarding", async (request, reply) => {
    const { userId } = requireUser(request);
    const body = patchOnboardingSchema.parse(request.body);
    const memberId = await resolveOnboardingMembershipId(app, userId, body.organizationId);

    if (body.dismissed === true) {
      // Only stamp when not already set — re-clicks become a no-op rather
      // than resetting the original dismissal time.
      const result = await app.db
        .update(members)
        .set({ onboardingSuppressedAt: new Date(), onboardingSuppressedReason: "finish_later" })
        .where(and(eq(members.id, memberId), isNull(members.onboardingSuppressedAt)))
        .returning({ id: members.id });
      if (result.length > 0) {
        app.log.info({ event: "onboarding.dismissed", userId }, "onboarding funnel: stepper dismissed");
      }
    } else if (body.dismissed === false) {
      await app.db
        .update(members)
        .set({ onboardingSuppressedAt: null, onboardingSuppressedReason: null })
        .where(and(eq(members.id, memberId), isNull(members.onboardingCompletedAt)));
    }

    const [m] = await app.db
      .select({ onboardingSuppressedAt: members.onboardingSuppressedAt })
      .from(members)
      .where(eq(members.id, memberId))
      .limit(1);
    return reply.status(200).send({
      dismissedAt: m?.onboardingSuppressedAt ? m.onboardingSuppressedAt.toISOString() : null,
    });
  });

  /**
   * POST /me/onboarding-completed — stamp the membership terminal-state column when
   * the user walks Step 3 to success (admin Continue, invitee Confirm /
   * Continue). Completion also writes the membership suppressor with
   * reason="completed"; `completed_at` remains the audit fact, while
   * `suppressed_at` is the redirect gate.
   *
   * Idempotent: only writes when the column is still NULL — re-calling on
   * an already-completed user is a no-op rather than resetting the stamp.
   */
  app.post("/me/onboarding-completed", async (request, reply) => {
    const { userId } = requireUser(request);
    const body = completeOnboardingSchema.parse(request.body ?? {});
    const memberId = await resolveOnboardingMembershipId(app, userId, body.organizationId);
    const now = new Date();
    const result = await app.db
      .update(members)
      .set({
        onboardingCompletedAt: now,
        onboardingSuppressedAt: now,
        onboardingSuppressedReason: "completed",
      })
      .where(and(eq(members.id, memberId), isNull(members.onboardingCompletedAt)))
      .returning({ id: members.id });
    if (result.length > 0) {
      app.log.info({ event: "onboarding.completed", userId }, "onboarding funnel: setup completed");
    }
    return reply.status(200).send({ ok: true });
  });

  /**
   * POST /me/onboarding/kickoff — idempotent server-side tail of onboarding.
   * Folds the three steps the browser used to orchestrate sequentially (create
   * the first chat → send the bootstrap message → stamp completion) into one
   * resumable request. Re-running it (reopened tab, network retry, Context setup
   * recovery) reuses the same first chat and stamps completion only once,
   * instead of leaving the orphan-chat / duplicate-bootstrap / completed-stamp-
   * decoupled-from-reality states the client-orchestrated flow could produce.
   */
  app.post("/me/onboarding/kickoff", async (request, reply) => {
    const { userId } = requireUser(request);
    if (hasRetiredKickoffKind(request.body)) {
      return reply.status(409).send({
        error:
          'This onboarding kickoff request uses the retired "kind" contract. Refresh the First Tree web app and retry.',
        code: "stale_onboarding_kickoff_contract",
      });
    }
    const body = kickoffOnboardingSchema.parse(request.body);
    const campaign = body.campaign;
    if (campaign) {
      if (!app.config.growth.landingPagesEnabled) {
        return reply.status(404).send({
          error: "Growth landing pages are disabled on this First Tree deployment.",
          code: "feature_disabled",
        });
      }
      return reply.status(410).send({
        error: "Campaign quickstart moved to /me/landing-campaigns/start.",
        code: "campaign_kickoff_moved",
      });
    }
    const { memberId, humanAgentId, organizationId } = await resolveOnboardingMember(app, userId, body.organizationId);
    const campaignAction = resolveCampaignActionContext(body.campaignAction, body.scanFixRepoSlug);
    const result = await kickoffOnboarding(app.db, {
      memberId,
      humanAgentId,
      organizationId,
      targetAgentId: body.agentUuid,
      bootstrap: body.bootstrap,
      topic: body.topic ?? "Get started with First Tree",
      // Campaign actions key on campaign + repo so the direct and onboarding
      // launchers converge; a normal kickoff remains per-(human, agent).
      kickoffKey: campaignAction
        ? campaignActionKickoffKey(humanAgentId, campaignAction)
        : `${humanAgentId}:${body.agentUuid}:onboarding`,
      complete: body.complete ?? true,
    });
    if (result.sent) {
      notifyRecipients(app.notifier, result.sent.recipients, result.sent.messageId);
      app.log.info({ event: "onboarding.kickoff", userId, chatId: result.chatId }, "onboarding funnel: kickoff");
    }
    return reply.status(200).send({ chatId: result.chatId });
  });

  /**
   * Retired browser contract. Keep an authenticated, non-mutating boundary so
   * a tab loaded before the setup-chat migration receives a controlled answer
   * instead of an ambiguous route-level 404.
   */
  app.post("/me/onboarding/tree-setup/kickoff", async (request, reply) => {
    requireUser(request);
    return reply.status(410).send({
      error: "Context Tree setup moved to the team-scoped setup-chat endpoint. Refresh First Tree and try again.",
      code: "tree_setup_kickoff_moved",
    });
  });

  /**
   * GET /me/onboarding/tree-setup-status — recovery probe for the Context
   * setup surface and Settings nav. A missing tree binding still needs
   * setup. A binding created after the org's value-first first chat completed
   * also needs setup until a tree setup bootstrap message exists; this covers
   * the recoverable edge where Cloud wrote `context_tree` but the background
   * tree setup kickoff failed before notifying the agent. The recovery decision is
   * org-level: different admins in the same org must not see different setup
   * debt just because their own onboarding completion timestamps differ.
   */
  app.get("/me/onboarding/tree-setup-status", async (request) => {
    const { userId } = requireUser(request);
    const query = onboardingTreeSetupStatusQuerySchema.parse(request.query);
    const memberId = await resolveOnboardingMembershipId(app, userId, query.organizationId);
    const [member] = await app.db
      .select({
        organizationId: members.organizationId,
        role: members.role,
      })
      .from(members)
      .where(eq(members.id, memberId))
      .limit(1);
    if (!member) throw new NotFoundError("Membership not found");

    if (member.role !== "admin") {
      return {
        needsTreeSetup: false,
        hasTreeBinding: false,
        hasTreeSetupKickoff: false,
      };
    }

    const tree = await getOrgContextTreeWithMeta(app.db, member.organizationId);
    const hasTreeBinding = tree.binding !== null;
    const hasTreeSetupKickoff = await hasTreeSetupKickoffMessage(app.db, member.organizationId);
    const [firstCompletedMembership] = await app.db
      .select({ onboardingCompletedAt: members.onboardingCompletedAt })
      .from(members)
      .where(and(eq(members.organizationId, member.organizationId), isNotNull(members.onboardingCompletedAt)))
      .orderBy(asc(members.onboardingCompletedAt))
      .limit(1);
    const orgOnboardingCompletedAt = firstCompletedMembership?.onboardingCompletedAt ?? null;
    const bindingCreatedAfterOrgCompletion =
      hasTreeBinding &&
      tree.updatedAt !== null &&
      orgOnboardingCompletedAt !== null &&
      tree.updatedAt >= orgOnboardingCompletedAt;

    return {
      needsTreeSetup: !hasTreeBinding || (bindingCreatedAfterOrgCompletion && !hasTreeSetupKickoff),
      hasTreeBinding,
      hasTreeSetupKickoff,
    };
  });

  /**
   * POST /me/onboarding/events — web-side onboarding funnel reporter.
   * Server-side milestones (`team_created` at OAuth, `dismissed` on PATCH)
   * are emitted directly; this endpoint surfaces the web-driven ones into
   * the same log stream so a single funnel query covers the full flow.
   * Body shape is enum-validated so the server won't log arbitrary names.
   *
   * The global actor-aware rate limiter is the safety cap; the schema keeps
   * this endpoint to known funnel event names.
   */
  app.post("/me/onboarding/events", async (request, reply) => {
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
  });

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
    let token: string;
    try {
      const github = await getFreshGithubUserToken(
        app.db,
        userId,
        app.config.secrets.encryptionKey,
        app.config.oauth?.githubApp,
      );
      token = github.accessToken;
    } catch (err) {
      if (err instanceof GithubUserTokenError) {
        if (err.cause) {
          app.log.warn({ err: err.cause, userId }, "github user-token refresh failed");
        }
        return reply.status(err.statusCode).send({
          error: err.message,
          ...(err.code ? { code: err.code } : {}),
        });
      }
      throw err;
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
   * The public token is a bare short code; the CLI picks the channel/default
   * server URL and rejoins via `exchangeConnectToken`, which consumes the code
   * and probes `members` realtime before issuing user credentials.
   *
   * Rate limiting is the global actor-aware `@fastify/rate-limit` guard
   * registered in `app.ts`; this user-authenticated route should not introduce
   * a separate low per-route cap.
   */
  // codeql[js/missing-rate-limiting]
  app.post("/me/connect-tokens", async (request) => {
    const { userId } = requireUser(request);
    const issuer = resolvePublicUrl(app, request);
    const { token, expiresIn } = await authService.generateConnectToken(app.db, userId, app.config.auth, issuer);
    // Web surfaces render the server-provided command directly. Dev is
    // source-only; hosted channels always use their public shell installer.
    const ch = getChannelConfig(app.config.channel);
    const command = buildLoginCommand({
      executable: ch.binName,
      tokenArg: shellArg(token),
      serverUrl: issuer,
      defaultServerUrl: ch.defaultServerUrl,
    });
    if (app.config.channel === "dev") {
      return {
        token,
        expiresIn,
        command,
        bootstrapCommand: command,
        installerUrl: null,
        binName: ch.binName,
      };
    }

    const installerPath = ch.portable.publicInstallerPath;
    const defaultPortableDownloadBaseUrl = ch.portable.downloadBaseUrl;
    if (installerPath === null || defaultPortableDownloadBaseUrl === null) {
      throw new Error(`Portable installer metadata is missing for the ${app.config.channel} channel`);
    }
    const portableDownloadBaseUrl = app.config.connectBootstrap.portableDownloadBaseUrl;
    const installerUrl = joinUrl(portableDownloadBaseUrl, installerPath);
    const bootstrapCommand = buildPortableBootstrapCommand({
      installerUrl,
      portableDownloadBaseUrl,
      defaultPortableDownloadBaseUrl,
      binName: ch.binName,
      token,
      serverUrl: issuer,
      defaultServerUrl: ch.defaultServerUrl,
    });
    return {
      token,
      expiresIn,
      command,
      bootstrapCommand,
      installerUrl,
      binName: ch.binName,
    };
  });

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
      status: r.status,
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
   * caller's user, excluding deleted agents. Used by the SDK reconcile layer
   * to authoritatively map `agents.runtime_provider` and retain suspended
   * local aliases without treating them as unowned.
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
    const binName = getChannelConfig(app.config.channel).binName;
    return list.map((c) => ({
      id: c.id,
      userId: c.userId,
      status: clientService.clientStatusForApi(c),
      authState: clientService.deriveAuthState(c, refreshExpirySeconds),
      binName,
      sdkVersion: c.sdkVersion,
      hostname: c.hostname,
      os: c.os,
      agentCount: c.agentCount,
      connectedAt: serializeDate(c.connectedAt),
      lastSeenAt: c.lastSeenAt.toISOString(),
      capabilities: clientService.extractCapabilities(c.metadata),
      lastUpdateAttempt: clientService.extractLastUpdateAttempt(c.metadata),
      ...clientCommandVersionHint(app, c.sdkVersion),
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

  app.post("/me/organizations/join", { config: { otelRecordBody: true } }, async (request, reply) => {
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
  });

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

async function resolveOnboardingMembershipId(
  app: FastifyInstance,
  userId: string,
  organizationId?: string,
): Promise<string> {
  if (organizationId) {
    const [member] = await app.db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.userId, userId), eq(members.organizationId, organizationId), eq(members.status, "active")))
      .limit(1);
    if (!member) throw new NotFoundError(`Membership for organization "${organizationId}" not found`);
    return member.id;
  }

  const activeMemberships = await listActiveMemberships(app.db, userId);
  const picked = authService.pickDefaultMembership(
    activeMemberships.map((m) => ({ id: m.memberId, createdAt: m.createdAt })),
  );
  if (!picked) throw new NotFoundError("No active membership found");
  return picked.id;
}

/**
 * Resolve the onboarding membership AND its 1:1 human agent — the kickoff
 * endpoint needs both: `memberId` to stamp completion and `humanAgentId` to
 * create the chat / send the bootstrap as the caller. Reuses
 * `resolveOnboardingMembershipId` for the default-membership selection logic.
 */
async function resolveOnboardingMember(
  app: FastifyInstance,
  userId: string,
  organizationId?: string,
): Promise<{ memberId: string; humanAgentId: string; organizationId: string }> {
  const memberId = await resolveOnboardingMembershipId(app, userId, organizationId);
  const [row] = await app.db
    .select({ agentId: members.agentId, organizationId: members.organizationId })
    .from(members)
    .where(eq(members.id, memberId))
    .limit(1);
  if (!row) throw new NotFoundError("Membership not found");
  return { memberId, humanAgentId: row.agentId, organizationId: row.organizationId };
}

function hasRetiredKickoffKind(body: unknown): boolean {
  return typeof body === "object" && body !== null && "kind" in body;
}
