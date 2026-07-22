import type { FastifyInstance } from "fastify";
import { UnauthorizedError } from "../errors.js";

/**
 * Public Class C — `/api/v1/invitations/:token/preview`. Unauthenticated;
 * exposes only the org's display name & slug for the invite landing page.
 *
 * Authoritative invite-management routes (rotate, get) live in
 * `api/orgs/invitations.ts` (Class B, admin-gated).
 */
export async function publicInvitationRoutes(app: FastifyInstance): Promise<void> {
  const { previewInvitation } = await import("../services/invitation.js");
  app.get<{ Params: { token: string } }>("/:token/preview", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!request.params.token) throw new UnauthorizedError("Token required");
    const preview = await previewInvitation(app.db, request.params.token);
    return reply.send(preview);
  });
}
