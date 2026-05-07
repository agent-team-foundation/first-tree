import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural invariant — pins the result of the audit done while landing
 * #220 / #222. The bug those PRs cleaned up is "admin route uses
 * `memberScope(request)` directly for data filtering, ignoring
 * `?organizationId=`, so the dropdown's selected org has no effect". Every
 * regression so far has surfaced one route at a time and looked identical:
 * an `app.get` / `app.post` handler that calls `memberScope(request)` and
 * does not also call any of the org-aware resolvers.
 *
 * This test reads every file under `packages/server/src/api/admin/` and
 * fails when a file uses `memberScope(request)` without also referencing
 * one of the org-aware resolvers below. Files that legitimately operate on
 * the JWT default org only (e.g. system-config, organizations) live in the
 * whitelist with a comment explaining why.
 *
 * If you find yourself adding a file to the whitelist, please leave a
 * one-line `// jwt-default-only:` comment in the route file itself
 * explaining why so future readers don't have to reverse-engineer it.
 */
describe("admin routes: memberScope must be paired with an org-aware resolver", () => {
  const ADMIN_DIR = join(__dirname, "..", "api", "admin");

  /**
   * Helpers that authoritatively scope to the *target* org rather than the
   * JWT default. Adding a new helper here is a deliberate widening of the
   * invariant — review carefully.
   */
  const ORG_AWARE_RESOLVERS = [
    "resolveAdminScope",
    "requireMemberInOrg",
    "assertCanManage",
    "assertAgentVisible",
    "resolveOrganization",
    "resolveOrgId",
    "assertChatAccess",
  ];

  /** Files that are known JWT-default-only and don't need an org-aware
   * resolver. Document the why on each entry. */
  const WHITELIST: Record<string, string> = {
    // organizations.ts: system-level routes (list user's orgs, etc.) operate
    // only on the caller's identity, not on a target org's data.
    "organizations.ts": "system-level identity routes — no org filtering",
    // system-config.ts: server-global config; no per-org scoping by design.
    "system-config.ts": "system-global config — no org filtering",
    // ws-admin.ts: realtime admin WS handshake re-probes membership at
    // connect time per frame; the per-frame `organizationId` is validated
    // inline against `members`.
    "ws-admin.ts": "per-frame realtime probe in handshake handler",
  };

  const files = readdirSync(ADMIN_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  for (const file of files) {
    if (file in WHITELIST) continue;
    const src = readFileSync(join(ADMIN_DIR, file), "utf-8");
    if (!/\bmemberScope\(request\)/.test(src)) continue;
    it(`${file} pairs memberScope(request) with an org-aware resolver`, () => {
      const found = ORG_AWARE_RESOLVERS.filter((helper) => new RegExp(`\\b${helper}\\b`).test(src));
      expect(
        found.length > 0,
        `${file} calls memberScope(request) but does not use any of the org-aware resolvers ` +
          `[${ORG_AWARE_RESOLVERS.join(", ")}]. ` +
          "Pair memberScope(request) with one of those resolvers, or add the file to the whitelist " +
          "in this test with a // jwt-default-only: comment explaining why.",
      ).toBe(true);
    });
  }

  it("whitelist entries actually exist (no stale paths)", () => {
    const present = new Set(files);
    for (const f of Object.keys(WHITELIST)) {
      expect(present.has(f), `WHITELIST references ${f} but no such file exists in ${ADMIN_DIR}`).toBe(true);
    }
  });
});
