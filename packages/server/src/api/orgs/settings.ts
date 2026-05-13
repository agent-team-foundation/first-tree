import {
  isOrgSettingNamespace,
  ORG_SETTINGS_NAMESPACES,
  type OrgSettingNamespace,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../../errors.js";
import { requireOrgAdmin, requireOrgMembership } from "../../scope/require-org.js";
import * as orgSettingsService from "../../services/org-settings.js";

/**
 * Class B — `/api/v1/orgs/:orgId/settings/:namespace`.
 *
 * Generic per-org settings surface. The `:namespace` URL parameter is
 * dispatched against `ORG_SETTINGS_NAMESPACES` (in the shared package);
 * adding a new config group only requires registering it there — no new
 * route file.
 *
 * GET gating is per-namespace via `readPolicy` in the registry: namespaces
 * with no secret fields (`context_tree`, `source_repos`) are readable by
 * any active org member, so an invitee can see what tree and repos the
 * team is bound to before joining the chat. PUT and DELETE are always
 * admin-only regardless of namespace — non-admins must never mutate
 * org-wide config.
 */
export async function orgSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string; namespace: string } }>("/:namespace", async (request) => {
    const namespace = parseNamespace(request.params.namespace);
    const scope =
      ORG_SETTINGS_NAMESPACES[namespace].readPolicy === "member"
        ? await requireOrgMembership(request, app.db)
        : await requireOrgAdmin(request, app.db);
    return orgSettingsService.getOrgSetting(app.db, scope.organizationId, namespace);
  });

  app.put<{ Params: { orgId: string; namespace: string } }>(
    "/:namespace",
    { config: { otelRecordBody: true } },
    async (request) => {
      const scope = await requireOrgAdmin(request, app.db);
      const namespace = parseNamespace(request.params.namespace);
      return orgSettingsService.putOrgSetting(app.db, scope.organizationId, namespace, request.body, {
        updatedBy: scope.userId,
      });
    },
  );

  app.delete<{ Params: { orgId: string; namespace: string } }>("/:namespace", async (request, reply) => {
    const scope = await requireOrgAdmin(request, app.db);
    const namespace = parseNamespace(request.params.namespace);
    await orgSettingsService.deleteOrgSetting(app.db, scope.organizationId, namespace);
    reply.status(204).send();
  });
}

function parseNamespace(raw: string): OrgSettingNamespace {
  if (!isOrgSettingNamespace(raw)) {
    throw new BadRequestError(`Unknown organization-settings namespace: "${raw}"`);
  }
  return raw;
}
