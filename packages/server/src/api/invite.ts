import type { FastifyInstance } from "fastify";
import { NotFoundError } from "../errors.js";
import { previewInvite } from "../services/workspace-membership.js";

/**
 * Public invite-link preview. Surfaces the workspace's display name + slug
 * (no token, no admin-only fields) so the landing page at
 * `/invite/<token>` can render "Join Acme Engineering" without forcing the
 * user to sign in first. Returns 404 for unknown tokens — the design doc
 * §4.3 specifies "This invite link isn't valid. Ask your admin for the
 * correct link." as the user-facing string; the frontend maps the 404
 * status to that message.
 */
export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  app.get("/:token/preview", async (request) => {
    const { token } = request.params as { token: string };
    const preview = await previewInvite(app.db, token);
    if (!preview) {
      throw new NotFoundError("Invite token not found");
    }
    return preview;
  });
}
