import {
  createWorkspaceRequestSchema,
  joinWorkspaceRequestSchema,
  switchOrganizationRequestSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../errors.js";
import { requireAuthedUser } from "../middleware/require-identity.js";
import { signTokensForMember, switchOrganization } from "../services/auth.js";
import {
  createWorkspaceForUser,
  extractInviteToken,
  joinWorkspaceByInvite,
  listMyWorkspaces,
} from "../services/workspace-membership.js";

/**
 * Routes that operate on the authenticated user's set of workspaces. All of
 * them accept either a per-org `type: "access"` token (existing user) or a
 * rootless `type: "user"` token (just signed in, no workspace yet) — see
 * `userAuthHook`. Create / Join always return a fresh per-org token pair
 * scoped to the workspace the user landed in, so the frontend can drop the
 * rootless token immediately after the wizard's first step succeeds.
 */
export async function meWorkspacesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (request) => {
    const user = requireAuthedUser(request);
    const items = await listMyWorkspaces(app.db, user.userId);
    return { items };
  });

  app.post("/", async (request) => {
    const user = requireAuthedUser(request);
    const body = createWorkspaceRequestSchema.parse(request.body);
    const created = await createWorkspaceForUser(app.db, user.userId, body);
    const tokens = await signTokensForMember(
      {
        userId: user.userId,
        memberId: created.memberId,
        organizationId: created.workspaceId,
        role: created.role,
      },
      app.config.secrets.jwtSecret,
    );
    return {
      workspace: { organizationId: created.workspaceId, memberId: created.memberId, role: created.role },
      ...tokens,
    };
  });

  app.post("/join", async (request) => {
    const user = requireAuthedUser(request);
    const body = joinWorkspaceRequestSchema.parse(request.body);
    const token = extractInviteToken(body.tokenOrUrl);
    if (!token) {
      // Friendly text matches the design doc §4.4 "链接格式错" wording so the
      // frontend can render the server's response without re-mapping it.
      throw new BadRequestError("Doesn't look like a valid invite link");
    }
    const joined = await joinWorkspaceByInvite(app.db, user.userId, token);
    const tokens = await signTokensForMember(
      {
        userId: user.userId,
        memberId: joined.memberId,
        organizationId: joined.workspaceId,
        role: joined.role,
      },
      app.config.secrets.jwtSecret,
    );
    return {
      workspace: { organizationId: joined.workspaceId, memberId: joined.memberId, role: joined.role },
      alreadyMember: joined.alreadyMember,
      ...tokens,
    };
  });
}

/**
 * `POST /api/v1/auth/switch-org` — re-issue tokens scoped to a different
 * workspace the caller already belongs to. We re-verify membership in
 * `switchOrganization` so a forged organizationId in the body buys nothing.
 */
export async function switchOrgRoutes(app: FastifyInstance): Promise<void> {
  app.post("/switch-org", async (request) => {
    const user = requireAuthedUser(request);
    const body = switchOrganizationRequestSchema.parse(request.body);
    const tokens = await switchOrganization(app.db, user.userId, body.organizationId, app.config.secrets.jwtSecret);
    return tokens;
  });
}
