import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { ensureFreshAccessToken, resolveServerUrl } from "../../core/bootstrap.js";
import { errorMessage } from "../../core/error-message.js";
import { print } from "../../core/output.js";

export function registerOrgBindTreeCommand(org: Command): void {
  org
    .command("bind-tree")
    .description("Bind the caller's organization to a context-tree GitHub URL")
    .argument("<url>", "GitHub URL of the context-tree repository (https://github.com/...)")
    .option("--org <orgId>", "Override the org to bind. Defaults to your selected/default org via /me.")
    .action(async (rawUrl: string, options: { org?: string }) => {
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

        // Explicit `--org` wins. Otherwise resolve from `/me`'s default the
        // same way the web does — fall back to the only membership; refuse
        // to guess for users with multiple orgs and no default.
        const orgId = options.org?.trim() || (await resolveDefaultOrgId(serverUrl, accessToken));

        const res = await fetch(`${serverUrl}/api/v1/orgs/${encodeURIComponent(orgId)}/settings/context_tree`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ repo: url }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          fail(
            "PUT_FAILED",
            `server returned ${res.status} on PUT /orgs/${orgId}/settings/context_tree: ${text.slice(0, 256)}`,
            1,
          );
        }

        print.status("•", `Bound organization to context-tree at ${url}`);
        success({ orgId, repo: url });
      } catch (err) {
        const msg = errorMessage(err);
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
    fail("ME_FAILED", `server returned ${res.status} on /me`, 1);
  }
  const me = (await res.json()) as {
    memberships?: Array<{ organizationId: string }>;
    defaultOrganizationId?: string | null;
  };
  const memberships = Array.isArray(me.memberships) ? me.memberships : [];
  if (me.defaultOrganizationId && memberships.some((m) => m.organizationId === me.defaultOrganizationId)) {
    return me.defaultOrganizationId;
  }
  if (memberships.length === 1 && memberships[0]) return memberships[0].organizationId;
  if (memberships.length === 0) {
    fail("NO_ORG", "You don't belong to any organization", 1);
  }
  fail(
    "AMBIGUOUS_ORG",
    "Multiple organizations — pass --org <orgId> explicitly or set a default in the web UI first",
    1,
  );
}
