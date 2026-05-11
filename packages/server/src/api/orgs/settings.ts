import {
  isOrgSettingNamespace,
  ORG_SETTINGS_NAMESPACES,
  type OrgSettingNamespace,
  type OrgSettingOutput,
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
 * team is bound to before joining the chat. Namespaces whose masked output
 * still leaks a `…Configured` boolean (`github_integration`) stay
 * admin-only. PUT and DELETE are always admin-only regardless of
 * namespace — non-admins must never mutate org-wide config.
 */
export async function orgSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string; namespace: string } }>("/:namespace", async (request) => {
    const namespace = parseNamespace(request.params.namespace);
    const scope =
      ORG_SETTINGS_NAMESPACES[namespace].readPolicy === "member"
        ? await requireOrgMembership(request, app.db)
        : await requireOrgAdmin(request, app.db);
    const out = await orgSettingsService.getOrgSetting(app.db, scope.organizationId, namespace);
    return enrichOutput(namespace, out, scope.organizationId, app.config.server.publicUrl);
  });

  app.put<{ Params: { orgId: string; namespace: string } }>(
    "/:namespace",
    { config: { otelRecordBody: true } },
    async (request) => {
      const scope = await requireOrgAdmin(request, app.db);
      const namespace = parseNamespace(request.params.namespace);
      const out = await orgSettingsService.putOrgSetting(app.db, scope.organizationId, namespace, request.body, {
        updatedBy: scope.userId,
        encryptionKey: app.config.secrets.encryptionKey,
      });
      return enrichOutput(namespace, out, scope.organizationId, app.config.server.publicUrl);
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

/**
 * Resolve namespace-specific server-config-derived fields. The service
 * layer stays config-agnostic — namespace knowledge that needs `app.config`
 * lives here.
 *
 * Currently a pass-through: the only previous resident
 * (`github_integration.webhookUrl`) was removed in the D3 cutover when
 * the per-org webhook URL was retired. Kept as a seam for future
 * namespaces that need the same publicUrl-aware shape.
 */
function enrichOutput<K extends OrgSettingNamespace>(
  namespace: K,
  out: OrgSettingOutput<K>,
  _orgId: string,
  _publicUrl: string | undefined,
): OrgSettingOutput<K> {
  // Suppress "namespace is unused" by reading it in a no-op branch.
  void namespace;
  return out;
}
