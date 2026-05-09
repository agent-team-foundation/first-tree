import {
  isOrgSettingNamespace,
  type OrgSettingNamespace,
  type OrgSettingOutput,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { BadRequestError } from "../../errors.js";
import { requireOrgAdmin } from "../../scope/require-org.js";
import * as orgSettingsService from "../../services/org-settings.js";

/**
 * Class B — `/api/v1/orgs/:orgId/settings/:namespace`.
 *
 * Generic per-org settings surface. The `:namespace` URL parameter is
 * dispatched against `ORG_SETTINGS_NAMESPACES` (in the shared package);
 * adding a new config group only requires registering it there — no new
 * route file.
 *
 * All three verbs are admin-only. Even GET, because the masked output
 * still leaks "configured / not-configured" booleans for secret fields,
 * which we don't want to expose to non-admin members.
 */
export async function orgSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string; namespace: string } }>("/:namespace", async (request) => {
    const scope = await requireOrgAdmin(request, app.db);
    const namespace = parseNamespace(request.params.namespace);
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
 * lives here. Currently only `github_integration.webhookUrl` qualifies.
 *
 * If `server.publicUrl` is unset on the Hub, `webhookUrl` is left as `""`
 * so the UI can render a "contact your site administrator" notice rather
 * than fall back to `window.location.origin` (which is wrong behind a
 * reverse proxy). (#12)
 */
function enrichOutput<K extends OrgSettingNamespace>(
  namespace: K,
  out: OrgSettingOutput<K>,
  orgId: string,
  publicUrl: string | undefined,
): OrgSettingOutput<K> {
  if (namespace === "github_integration") {
    const o = out as OrgSettingOutput<"github_integration">;
    const webhookUrl = publicUrl ? `${publicUrl.replace(/\/+$/, "")}/api/v1/webhooks/github/${orgId}` : "";
    return { ...o, webhookUrl } as OrgSettingOutput<K>;
  }
  return out;
}
