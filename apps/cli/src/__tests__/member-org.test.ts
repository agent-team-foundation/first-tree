import { describe, expect, it } from "vitest";
import { MemberOrganizationResolutionError, resolveMemberOrganizationId } from "../core/member-org.js";

describe("member Team resolution", () => {
  it("prefers an explicit active membership, then /me's default, then the sole membership", () => {
    const profile = {
      memberships: [{ organizationId: "org-a" }, { organizationId: "org-b" }],
      defaultOrganizationId: "org-b",
    };
    expect(resolveMemberOrganizationId(profile, " org-a ")).toBe("org-a");
    expect(resolveMemberOrganizationId(profile)).toBe("org-b");
    expect(
      resolveMemberOrganizationId({ memberships: [{ organizationId: "org-only" }], defaultOrganizationId: null }),
    ).toBe("org-only");
  });

  it("fails closed rather than guessing or accepting an unrelated Team id", () => {
    expect(() =>
      resolveMemberOrganizationId({
        memberships: [{ organizationId: "org-a" }, { organizationId: "org-b" }],
        defaultOrganizationId: null,
      }),
    ).toThrow(MemberOrganizationResolutionError);
    expect(() =>
      resolveMemberOrganizationId({ memberships: [{ organizationId: "org-a" }], defaultOrganizationId: null }, "x"),
    ).toThrow(expect.objectContaining({ code: "ORG_NOT_FOUND" }));
    expect(() => resolveMemberOrganizationId({ memberships: [], defaultOrganizationId: null })).toThrow(
      expect.objectContaining({ code: "NO_ORG" }),
    );
  });
});
