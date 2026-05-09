import type { Command } from "commander";
import { fail, success } from "../cli/output.js";
import { ensureFreshAccessToken, resolveServerUrl } from "../core/bootstrap.js";
import { print } from "../core/output.js";

/**
 * `first-tree-hub org` — organization-level operations.
 *
 * Today this only ships `set-tree-url`, called by Step 3 onboarding agents
 * after they create a fresh context-tree GitHub repo so the Hub records
 * the binding in `organizations.tree_url`. See
 * docs/new-user-onboarding-design.md §7.4 (Path B).
 */
export function registerOrgCommands(program: Command): void {
  const org = program.command("org").description("Organization-level operations");

  org
    .command("set-tree-url")
    .description("Bind the caller's organization to a context-tree GitHub URL")
    .argument("<url>", "GitHub URL of the context-tree repository (https://github.com/...)")
    .action(async (rawUrl: string) => {
      try {
        const url = rawUrl.trim();
        if (!url) {
          fail("INVALID_URL", "URL must not be empty", 2);
        }
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            fail("INVALID_URL", `URL scheme must be http or https (got ${parsed.protocol})`, 2);
          }
        } catch {
          fail("INVALID_URL", `"${url}" is not a valid URL`, 2);
        }

        const serverUrl = resolveServerUrl();
        const accessToken = await ensureFreshAccessToken();

        // Resolve the caller's selected / default organization the same way
        // the web does: ask `/me` for memberships + `defaultOrganizationId`,
        // pick the default if it's a real membership, otherwise the only
        // membership. Multiple memberships without a default is ambiguous.
        const orgId = await resolveDefaultOrgId(serverUrl, accessToken);

        const res = await fetch(`${serverUrl}/api/v1/orgs/${encodeURIComponent(orgId)}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ treeUrl: url }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          fail(
            "PATCH_FAILED",
            `hub returned ${res.status} on PATCH /orgs/${orgId}: ${text.slice(0, 256)}`,
            1,
          );
        }

        print.status("•", `Bound organization to context-tree at ${url}`);
        success({ orgId, treeUrl: url });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fail("UNEXPECTED", msg, 1);
      }
    });
}

async function resolveDefaultOrgId(serverUrl: string, accessToken: string): Promise<string> {
  const res = await fetch(`${serverUrl}/api/v1/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    fail("ME_FAILED", `hub returned ${res.status} on /me`, 1);
  }
  const me = (await res.json()) as {
    memberships?: Array<{ organizationId: string }>;
    defaultOrganizationId?: string | null;
  };
  const memberships = me.memberships ?? [];
  if (
    me.defaultOrganizationId &&
    memberships.some((m) => m.organizationId === me.defaultOrganizationId)
  ) {
    return me.defaultOrganizationId;
  }
  if (memberships.length === 1 && memberships[0]) return memberships[0].organizationId;
  if (memberships.length === 0) {
    fail("NO_ORG", "You don't belong to any organization", 1);
  }
  fail(
    "AMBIGUOUS_ORG",
    "Multiple organizations and no default selected — unset for now (set the default in the web UI first)",
    1,
  );
}
