import { afterEach, describe, expect, it } from "vitest";
import { setApiSelectedOrganizationId, withOrg, withOrgAt } from "../client.js";

/**
 * Tests for the org-prefix helpers. They replace the old `decoratePath` /
 * shared classifier scheme — the simpler design is "callers wrap org-scoped
 * paths with `withOrg` / `withOrgAt`; everything else goes verbatim", so all
 * we need to pin is:
 *
 *   1. `withOrg` formats correctly when an org is set
 *   2. `withOrg` throws (loud, traceable) when no org is set
 *   3. `withOrgAt` ignores the module-scope state
 *   4. URI-encoding of pathological org-id values
 */
describe("withOrg / withOrgAt", () => {
  afterEach(() => {
    setApiSelectedOrganizationId(null);
  });

  describe("withOrg", () => {
    it("prefixes the currently-selected org", () => {
      setApiSelectedOrganizationId("org-x");
      expect(withOrg("/agents")).toBe("/orgs/org-x/agents");
      expect(withOrg("/members")).toBe("/orgs/org-x/members");
      expect(withOrg("/agents?limit=100")).toBe("/orgs/org-x/agents?limit=100");
      expect(withOrg("/agents/names/foo/availability")).toBe("/orgs/org-x/agents/names/foo/availability");
      expect(withOrg("/adapters/status")).toBe("/orgs/org-x/adapters/status");
      // `listOrgClients()` in api/activity.ts wraps `/clients` with `withOrg` —
      // pin the resulting path here so a future rename of the helper or the
      // route prefix can't silently break the Computers page's admin view.
      expect(withOrg("/clients")).toBe("/orgs/org-x/clients");
    });

    it("throws if no org is selected (fail-loud, not silent 404)", () => {
      // The earlier `decoratePath` design fell through with the bare path here
      // and let the request 404 silently — that masked real bugs (calls firing
      // before the auth-context wired the org id, missed `meLoaded` gates,
      // etc.). The throw makes the broken caller visible in the React Query
      // error path instead.
      setApiSelectedOrganizationId(null);
      expect(() => withOrg("/agents")).toThrow(/before an organization is selected/);
    });

    it("uri-encodes the org id (defends against pathological values)", () => {
      setApiSelectedOrganizationId("a/b c");
      expect(withOrg("/clients")).toBe("/orgs/a%2Fb%20c/clients");
    });
  });

  describe("withOrgAt", () => {
    it("uses the explicit org regardless of module-scope state", () => {
      setApiSelectedOrganizationId("current-org");
      expect(withOrgAt("other-org", "/invitations")).toBe("/orgs/other-org/invitations");
      expect(withOrgAt("other-org", "/invitations/rotate")).toBe("/orgs/other-org/invitations/rotate");
    });

    it("works without any module-scope org being set", () => {
      // The cross-org admin tooling case — the panel knows which org it's
      // managing without depending on the user's currently-viewed org.
      setApiSelectedOrganizationId(null);
      expect(withOrgAt("admin-target-org", "/invitations")).toBe("/orgs/admin-target-org/invitations");
    });

    it("uri-encodes the explicit org id", () => {
      setApiSelectedOrganizationId(null);
      expect(withOrgAt("a/b c", "/invitations")).toBe("/orgs/a%2Fb%20c/invitations");
    });
  });
});
