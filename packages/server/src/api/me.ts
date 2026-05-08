import {
  createOrgFromMeSchema,
  joinByInvitationSchema,
  switchOrgSchema,
  type WizardStep,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "../errors.js";
import { requireMember } from "../middleware/require-identity.js";
import { listAgentsManagedByUser } from "../services/access-control.js";
import * as authService from "../services/auth.js";
import {
  buildInviteUrl,
  ensureActiveInvitation,
  findActiveByToken,
  getActiveInvitation,
  recordRedemption,
} from "../services/invitation.js";
import {
  ensureMembership,
  leaveOrganization,
  listActiveMemberships,
  selfCreateOrganization,
} from "../services/membership.js";
import { resolvePublicUrl } from "../utils/public-url.js";

/**
 * `/me` and self-service organization routes (mounted under the member
 * auth hook). The legacy `GET /me` shape is preserved + extended with
 * `wizard` and `inviteUrl` (admin only) so the web SPA can derive its
 * landing UI without an extra round-trip.
 */
export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (request) => {
    const m = requireMember(request);

    const [user] = await app.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(eq(users.id, m.userId))
      .limit(1);

    const [agent] = await app.db
      .select({
        uuid: agents.uuid,
        name: agents.name,
        displayName: agents.displayName,
        inboxId: agents.inboxId,
      })
      .from(agents)
      .where(eq(agents.uuid, m.agentId))
      .limit(1);

    const wizardStep = await inferWizardStep(app, m);

    let inviteUrl: string | null = null;
    if (m.role === "admin") {
      const inv = await getActiveInvitation(app.db, m.organizationId);
      if (inv) {
        inviteUrl = buildInviteUrl(resolvePublicUrl(app, request), inv.token);
      }
    }

    // Multi-org payload (decouple-client-from-identity §C1): the web client
    // derives `currentMembership` from `localStorage.selectedOrganizationId`
    // joined against this list, so it never has to call /auth/switch-org just
    // to learn which orgs the user belongs to.
    const memberships = await listActiveMemberships(app.db, m.userId);

    return {
      user: user ?? null,
      member: {
        id: m.memberId,
        organizationId: m.organizationId,
        role: m.role,
        agentId: m.agentId,
      },
      memberships: memberships.map((mb) => ({
        id: mb.memberId,
        organizationId: mb.organizationId,
        organizationName: mb.orgDisplayName,
        role: mb.role,
        agentId: mb.agentId,
      })),
      agent: agent ?? null,
      wizard: { step: wizardStep },
      inviteUrl,
    };
  });

  /**
   * POST /connect-tokens — generate a short-lived connect token for CLI authentication.
   * Stamped with `iss = server.publicUrl` (or the request host as a dev fallback)
   * so the CLI's `connect <token>` form can derive the hub URL with no extra arg.
   *
   * Rate-limited per-route at the same level as `/auth/login`: a "Copy
   * commands" double-click in the wizard mustn't burn through token slots,
   * but neither should a stolen access token mint unlimited connect tokens.
   */
  const loginMax = app.config.rateLimit?.loginMax ?? 5;
  app.post("/connect-tokens", { config: { rateLimit: { max: loginMax, timeWindow: "1 minute" } } }, async (request) => {
    const m = requireMember(request);
    const issuer = resolvePublicUrl(app, request);
    const { token, expiresIn } = await authService.generateConnectToken(
      { userId: m.userId, memberId: m.memberId, organizationId: m.organizationId, role: m.role },
      app.config.secrets.jwtSecret,
      app.config.auth,
      issuer,
    );

    // The new top-level `first-tree-hub connect <token>` derives the URL
    // from the token's iss claim; the legacy `client connect <url> --token`
    // form still works. Surface the simple form.
    const command = `first-tree-hub connect ${token}`;

    return { token, expiresIn, command };
  });

  // GET /me/managed-agents — cross-org list of every agent the caller
  // manages (decouple-client-from-identity §4.5.1 case (b)). Powers the
  // CLI `agent list` view, which now shows a multi-org user's full
  // managed agent set without an explicit `?organizationId=`. The web
  // roster stays org-scoped through the `/admin/agents` endpoint.
  app.get("/me/managed-agents", async (request) => {
    const m = requireMember(request);
    const rows = await listAgentsManagedByUser(app.db, m.userId);
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
    }));
  });

  // ── Self-service org management ───────────────────────────────────────────

  app.get("/me/organizations", async (request) => {
    const m = requireMember(request);
    const rows = await listActiveMemberships(app.db, m.userId);
    return rows.map((r) => ({
      id: r.organizationId,
      name: r.orgName,
      displayName: r.orgDisplayName,
      role: r.role,
    }));
  });

  app.post("/me/organizations", { config: { otelRecordBody: true } }, async (request, reply) => {
    const m = requireMember(request);
    const body = createOrgFromMeSchema.parse(request.body);

    const [u] = await app.db
      .select({ username: users.username, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, m.userId))
      .limit(1);
    if (!u) throw new NotFoundError("User not found");

    const created = await selfCreateOrganization(app.db, {
      userId: m.userId,
      userDisplayName: u.displayName,
      username: u.username,
      name: body.name,
      displayName: body.displayName,
    });
    const tokens = await authService.signTokensForMember(
      app.config.secrets.jwtSecret,
      {
        userId: m.userId,
        memberId: created.memberId,
        organizationId: created.organizationId,
        role: "admin",
      },
      app.config.auth,
    );
    return reply.status(201).send({
      organization: {
        id: created.organizationId,
        name: created.name,
        displayName: created.displayName,
        role: "admin",
      },
      tokens,
    });
  });

  // Rate-limit `join`: an attacker holding a valid access token shouldn't
  // be able to brute-force invite tokens via this endpoint. Same bucket
  // size as login.
  app.post(
    "/me/organizations/join",
    { config: { rateLimit: { max: loginMax, timeWindow: "1 minute" }, otelRecordBody: true } },
    async (request, reply) => {
      const m = requireMember(request);
      const body = joinByInvitationSchema.parse(request.body);

      const inv = await findActiveByToken(app.db, body.token);
      if (!inv) {
        return reply.status(404).send({ error: "Invitation not found or no longer valid" });
      }

      const [u] = await app.db
        .select({ username: users.username, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, m.userId))
        .limit(1);
      if (!u) throw new NotFoundError("User not found");

      const member = await ensureMembership(app.db, {
        userId: m.userId,
        organizationId: inv.organizationId,
        role: inv.role === "admin" ? "admin" : "member",
        displayName: u.displayName,
        username: u.username,
      });
      await recordRedemption(app.db, {
        invitationId: inv.id,
        userId: m.userId,
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });

      const tokens = await authService.signTokensForMember(
        app.config.secrets.jwtSecret,
        {
          userId: m.userId,
          memberId: member.id,
          organizationId: member.organizationId,
          role: member.role,
        },
        app.config.auth,
      );
      return reply.status(200).send({
        organizationId: member.organizationId,
        memberId: member.id,
        role: member.role,
        tokens,
      });
    },
  );

  app.post("/me/organizations/leave", async (request, reply) => {
    const m = requireMember(request);
    await leaveOrganization(app.db, m.memberId);
    return reply.status(204).send();
  });

  // POST /auth/switch-org degrades to a server-side authorization probe:
  // the call confirms the user is an active member of the target org and
  // returns 204. The web client now persists the selected org locally
  // (`localStorage.selectedOrganizationId`) and rederives every auth-context
  // field from `/me memberships` — no more JWT swap. WS connections keep
  // their existing bound agents (decouple-client-from-identity §4.6).
  app.post("/auth/switch-org", { config: { otelRecordBody: true } }, async (request, reply) => {
    const m = requireMember(request);
    const body = switchOrgSchema.parse(request.body);

    const [target] = await app.db
      .select({ id: members.id })
      .from(members)
      .where(
        and(
          eq(members.userId, m.userId),
          eq(members.organizationId, body.organizationId),
          eq(members.status, "active"),
        ),
      )
      .limit(1);
    if (!target) {
      throw new ForbiddenError("You do not belong to that organization");
    }

    return reply.status(204).send();
  });
}

/**
 * Infer the wizard step from observable runtime state. Refer to
 * proposal §"Onboarding 状态推断" for the rationale.
 *
 * Note: we deliberately do NOT filter by `clients.status='connected'`
 * here. The original "fact-is-state" reading would have flapped between
 * `completed` and `connect` every time the user's client briefly went
 * offline — UX disaster (the onboarding modal would re-pop). "Ever
 * connected" (= a clients row exists at all for this user/org) is still
 * fact-derived: deleting the row really does rewind the wizard, and
 * that's the explicit reset path.
 */
async function inferWizardStep(
  app: FastifyInstance,
  m: { userId: string; memberId: string; organizationId: string },
): Promise<WizardStep> {
  const [hasClient] = await app.db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.userId, m.userId))
    .limit(1);
  if (!hasClient) return "connect";

  const [hasAgent] = await app.db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(and(eq(agents.managerId, m.memberId), ne(agents.type, "human"), eq(agents.status, "active")))
    .limit(1);
  if (!hasAgent) return "create_agent";
  return "completed";
}

/**
 * Public route exported separately so it mounts BEFORE the member auth hook.
 * Just exposes the org's display name & slug for the unauthenticated `/invite/:token`
 * landing page.
 */
export async function publicInvitePreviewRoute(app: FastifyInstance): Promise<void> {
  const { previewInvitation } = await import("../services/invitation.js");
  app.get<{ Params: { token: string } }>("/:token/preview", async (request, reply) => {
    if (!request.params.token) throw new UnauthorizedError("Token required");
    const preview = await previewInvitation(app.db, request.params.token);
    return reply.send(preview);
  });
}

/**
 * Admin-only invitation routes — mounted under `/admin/organizations/:id/invitations`.
 */
export async function adminInvitationRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/", async (request) => {
    const m = requireMember(request);
    if (m.role !== "admin") throw new ForbiddenError("Admin role required");
    if (request.params.id !== m.organizationId) {
      throw new ForbiddenError("Cannot inspect invitations for another organization");
    }
    const inv = await ensureActiveInvitation(app.db, m.organizationId, m.userId);
    return {
      id: inv.id,
      organizationId: inv.organizationId,
      token: inv.token,
      inviteUrl: buildInviteUrl(resolvePublicUrl(app, request), inv.token),
      role: inv.role,
      createdAt: inv.createdAt.toISOString(),
      expiresAt: inv.expiresAt ? inv.expiresAt.toISOString() : null,
    };
  });

  app.post<{ Params: { id: string } }>("/rotate", async (request) => {
    const m = requireMember(request);
    if (m.role !== "admin") throw new ForbiddenError("Admin role required");
    if (request.params.id !== m.organizationId) {
      throw new ForbiddenError("Cannot rotate invitations for another organization");
    }
    const { rotateInvitation } = await import("../services/invitation.js");
    const inv = await rotateInvitation(app.db, m.organizationId, m.userId);
    return {
      id: inv.id,
      organizationId: inv.organizationId,
      token: inv.token,
      inviteUrl: buildInviteUrl(resolvePublicUrl(app, request), inv.token),
      role: inv.role,
      createdAt: inv.createdAt.toISOString(),
      expiresAt: inv.expiresAt ? inv.expiresAt.toISOString() : null,
    };
  });
}
