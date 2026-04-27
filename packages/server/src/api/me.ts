import { onboardingStateSchema } from "@agent-team-foundation/first-tree-hub-shared";
import { and, eq, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { users } from "../db/schema/users.js";
import { requireMember } from "../middleware/require-identity.js";
import * as authService from "../services/auth.js";

/** GET /me — returns current user + member + agent info, plus wizard state. */
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

    // Wizard state — per (user × workspace) checkpoint stored on
    // `members.onboarding_state`. Surfaced here so the frontend can
    // pick the wizard step in a single round-trip rather than
    // hitting a separate /onboarding endpoint.
    const [memberRow] = await app.db
      .select({ onboardingState: members.onboardingState })
      .from(members)
      .where(eq(members.id, m.memberId))
      .limit(1);

    // Cross-workspace skip signal (P0-5 in docs/saas-onboarding-journey.md
    // §6.1): if the user has a connected client in ANY of their other
    // workspaces, they've already completed the Connect screen for that
    // physical machine; the wizard for this workspace can skip Step 1.
    // We deliberately exclude the current workspace from the check —
    // if they're connected HERE, the regular wizard polling sees it
    // and advances; the cross-workspace flag is for the brand-new
    // membership case.
    const elsewhere = await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(clients)
      .where(
        and(
          eq(clients.userId, m.userId),
          eq(clients.status, "connected"),
          ne(clients.organizationId, m.organizationId),
        ),
      );
    const hasConnectedClientElsewhere = (elsewhere[0]?.count ?? 0) > 0;

    return {
      user: user ?? null,
      member: {
        id: m.memberId,
        organizationId: m.organizationId,
        role: m.role,
        agentId: m.agentId,
        onboardingState: memberRow?.onboardingState ?? null,
      },
      agent: agent ?? null,
      wizard: {
        hasConnectedClientElsewhere,
      },
    };
  });

  /**
   * PATCH /me/onboarding-state — write the wizard checkpoint for the
   * caller's current membership. We don't expose the full members table
   * for self-service; only the onboarding_state column is writable, and
   * only for the caller's own member row. The body is validated against
   * `onboardingStateSchema` to keep the JSONB shape stable.
   */
  app.patch("/me/onboarding-state", async (request, reply) => {
    const m = requireMember(request);
    const body = onboardingStateSchema.parse(request.body);
    await app.db.update(members).set({ onboardingState: body }).where(eq(members.id, m.memberId));
    return reply.status(204).send();
  });

  /**
   * POST /connect-tokens — generate a short-lived connect token for CLI authentication.
   * The token can be exchanged via POST /auth/connect-token for full credentials.
   */
  app.post("/connect-tokens", async (request) => {
    const m = requireMember(request);
    const { token, expiresIn } = await authService.generateConnectToken(
      { userId: m.userId, memberId: m.memberId, organizationId: m.organizationId, role: m.role },
      app.config.secrets.jwtSecret,
    );

    // Build the CLI connect command. Prefer the explicit `server.publicUrl`
    // (deployments behind a CDN that strips forwarded headers); fall back
    // to forwarded-proto/host or the request's own headers (self-host,
    // direct access). Without the configured-first preference, a hub
    // running behind a proxy that drops `x-forwarded-*` would advertise
    // an unreachable `http://127.0.0.1:8000/...` to the wizard.
    const configuredUrl = app.config.server.publicUrl;
    let serverUrl: string;
    if (configuredUrl) {
      serverUrl = configuredUrl.replace(/\/+$/, "");
    } else {
      const proto = request.headers["x-forwarded-proto"] ?? request.protocol;
      const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? request.hostname;
      serverUrl = `${proto}://${host}`;
    }
    const command = `first-tree-hub client connect ${serverUrl} --token ${token}`;

    return { token, expiresIn, command };
  });
}
