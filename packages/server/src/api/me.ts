import {
  createOrgFromMeSchema,
  joinByInvitationSchema,
  type WizardStep,
} from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { NotFoundError } from "../errors.js";
import { requireUser } from "../scope/require-user.js";
import { listAgentsManagedByUser } from "../services/access-control.js";
import * as authService from "../services/auth.js";
import { buildInviteUrl, findActiveByToken, getActiveInvitation, recordRedemption } from "../services/invitation.js";
import {
  ensureMembership,
  leaveOrganization,
  listActiveMemberships,
  selfCreateOrganization,
} from "../services/membership.js";
import { resolvePublicUrl } from "../utils/public-url.js";

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

    const wizardStep = await inferWizardStep(app, userId);

    return {
      user: user ?? null,
      defaultOrganizationId: defaultOrgId,
      memberships: memberships.map((mb) => ({
        id: mb.memberId,
        organizationId: mb.organizationId,
        organizationName: mb.orgDisplayName,
        role: mb.role,
        agentId: mb.agentId,
      })),
      wizard: { step: wizardStep },
      inviteUrl,
    };
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
      const command = `first-tree-hub connect ${token}`;
      return { token, expiresIn, command };
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
   * GET /me/wizard-step — bare endpoint for clients that don't want the
   * full /me payload. Same logic as inferWizardStep below.
   */
  app.get("/me/wizard-step", async (request) => {
    const { userId } = requireUser(request);
    const step = await inferWizardStep(app, userId);
    return { step };
  });
}

/**
 * Infer the onboarding wizard step from the *user-level* facts:
 *   - has at least one client → past "connect"
 *   - manages at least one non-human active agent (any org) → past "create_agent"
 *
 * Critically: the join from agents → members → userId means a user with
 * memberships across multiple orgs has the wizard satisfied as soon as ANY
 * org has a non-human agent — matching the user-level mental model.
 */
async function inferWizardStep(app: FastifyInstance, userId: string): Promise<WizardStep> {
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
