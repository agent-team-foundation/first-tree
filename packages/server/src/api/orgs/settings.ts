import { isOrgSettingNamespace, ORG_SETTINGS_NAMESPACES, type OrgSettingNamespace } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { BadRequestError, ConflictError, GoneError } from "../../errors.js";
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
 *
 * `context_tree` has two read surfaces: the generic namespace URL is always
 * runtime-safe, while `/context_tree/raw` is an admin-only repair view for
 * loose historical rows.
 */
export async function orgSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { orgId: string } }>("/context_tree/raw", async (request) => {
    const scope = await requireOrgAdmin(request, app.db);
    return orgSettingsService.getOrgSetting(app.db, scope.organizationId, "context_tree");
  });

  app.get<{ Params: { orgId: string; namespace: string } }>("/:namespace", async (request) => {
    const namespace = parseNamespace(request.params.namespace);
    const scope =
      ORG_SETTINGS_NAMESPACES[namespace].readPolicy === "member"
        ? await requireOrgMembership(request, app.db)
        : await requireOrgAdmin(request, app.db);
    if (namespace === "context_tree") {
      const current = await orgSettingsService.getOrgContextTreeWithMeta(app.db, scope.organizationId);
      if (current.binding) return current.binding;
      if (current.updatedAt) {
        throw new ConflictError(
          "Context Tree setting contains invalid historical data and must be repaired by an admin",
        );
      }
      return { branch: "main" };
    }
    return orgSettingsService.getOrgSetting(app.db, scope.organizationId, namespace);
  });

  app.put<{ Params: { orgId: string; namespace: string } }>(
    "/:namespace",
    // Context Tree settings can contain private repository coordinates, and
    // rejected legacy values can contain embedded credentials. Do not attach
    // this generic settings body to failure spans.
    { config: { otelRecordBody: false } },
    async (request) => {
      const scope = await requireOrgAdmin(request, app.db);
      const namespace = parseNamespace(request.params.namespace);
      if (namespace === "source_repos") {
        throw new GoneError("source_repos is read-only; use Team Resources instead");
      }
      return orgSettingsService.putOrgSetting(app.db, scope.organizationId, namespace, request.body, {
        memberId: scope.memberId,
        updatedBy: scope.userId,
      });
    },
  );

  app.delete<{ Params: { orgId: string; namespace: string } }>("/:namespace", async (request, reply) => {
    const scope = await requireOrgAdmin(request, app.db);
    const namespace = parseNamespace(request.params.namespace);
    if (namespace === "source_repos") {
      throw new GoneError("source_repos is read-only; use Team Resources instead");
    }
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
