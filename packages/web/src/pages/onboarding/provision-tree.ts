import { ApiError } from "../../api/client.js";
import { initializeContextTree } from "../../api/context-tree.js";
import { getContextTreeSetting } from "../../api/org-settings.js";

/**
 * Provision a fresh Context Tree for the new-tree onboarding path: create the
 * repo + write the org `context_tree` binding via the admin initializer. Runs
 * before the kickoff message is sent so the agent's session resolves the
 * binding and `first-tree-seed`'s preconditions hold.
 *
 * A `409` from the initializer is ambiguous — it can mean the tree is **already
 * provisioned** (a detect→create race, or a retry after a later kickoff step
 * failed) OR that **no tree could be created** (the merged initializer also
 * returns 409 for `organization_installation_required` /
 * `selected_repositories_unsupported`). We distinguish by the **actual binding
 * state** rather than the status code (the "already configured" conflict
 * carries no discriminating `code`): if a tree now exists, provisioning
 * effectively succeeded and we proceed; otherwise we re-throw so the user sees
 * the actionable error and can fix their GitHub setup. Every non-409 error
 * (e.g. `403 installation_permissions_insufficient`) propagates unchanged.
 */
export async function provisionNewTree(organizationId: string): Promise<void> {
  try {
    await initializeContextTree(organizationId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      const setting = await getContextTreeSetting(organizationId).catch(() => null);
      if (setting?.repo) return; // a tree binding exists — treat as provisioned
    }
    throw err;
  }
}
