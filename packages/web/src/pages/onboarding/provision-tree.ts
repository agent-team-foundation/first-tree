import { canonicalizeResourceRepoUrl } from "@first-tree/shared";
import { ApiError } from "../../api/client.js";
import { initializeContextTree } from "../../api/context-tree.js";
import { getContextTreeSetting } from "../../api/org-settings.js";
import { createTeamResourceForOrg, listTeamResourcesForOrg } from "../../api/resources.js";

/** Reduce a repo URL to its `owner/name` path (protocol/host/.git stripped) —
 *  for the human-readable resource name and error text. */
export function repoLabel(url: string): string {
  return url
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^git@[^:]+:/, "")
    .replace(/\.git$/, "");
}

/**
 * Canonical key for matching a selected repo against a registered resource.
 * Uses the SAME `canonicalizeResourceRepoUrl` the server keys `repoCanonicalKey`
 * off, so an existing resource registered under an https / ssh / scp form of the
 * same repo matches a selected clone URL — a weaker label-based match would
 * wrongly report it missing and block the user on the duplicate/retry path.
 * Falls back to the raw string when a stored URL can't be parsed, so a malformed
 * entry simply fails to match rather than throwing out of the verify.
 */
function repoKey(url: string): string {
  try {
    return canonicalizeResourceRepoUrl(url);
  } catch {
    return url;
  }
}

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

/**
 * Register the selected source repos as `recommended` team repo resources —
 * REQUIRED for new-tree mode, because that is the only path by which they reach
 * the agent's runtime `gitRepos` → on-disk sources → `workspace.json.sources` →
 * the source set `first-tree-seed` requires. Without this, a silently-dropped
 * resource write would leave onboarding with a provisioned tree but a missing
 * bound source, and the seed flow would refuse or seed an incomplete set.
 *
 * Creates each resource (tolerating "already exists" conflicts from a re-run —
 * the canonical-key unique index makes a duplicate create throw 409), then
 * **verifies** every selected repo is actually registered and throws if any is
 * missing, so the caller surfaces an actionable error and the user retries
 * rather than seeding an empty/incomplete source set.
 */
export async function ensureSourceReposRegistered(organizationId: string, repoUrls: readonly string[]): Promise<void> {
  if (repoUrls.length === 0) return;

  // Best-effort create; duplicates (and transient failures) are reconciled by
  // the authoritative verify below.
  await Promise.allSettled(
    repoUrls.map((url) =>
      createTeamResourceForOrg(organizationId, {
        type: "repo",
        name: repoLabel(url),
        defaultEnabled: "recommended",
        payload: { url },
      }),
    ),
  );

  const registered = new Set(
    (await listTeamResourcesForOrg(organizationId))
      .filter((resource) => resource.type === "repo" && resource.defaultEnabled === "recommended")
      .map((resource) => {
        const url = (resource.payload as { url?: unknown }).url;
        return typeof url === "string" ? repoKey(url) : "";
      }),
  );

  const missing = repoUrls.filter((url) => !registered.has(repoKey(url)));
  if (missing.length > 0) {
    throw new Error(
      `Couldn't register ${missing.length} source repo${missing.length > 1 ? "s" : ""} for the new Context Tree (${missing
        .map(repoLabel)
        .join(", ")}). Try again.`,
    );
  }
}
