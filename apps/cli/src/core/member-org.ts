export type MemberOrganizationProfile = {
  memberships: Array<{ organizationId: string }>;
  defaultOrganizationId: string | null;
};

export type MemberOrganizationResolutionCode = "AMBIGUOUS_ORG" | "INVALID_ORG" | "NO_ORG" | "ORG_NOT_FOUND";

export class MemberOrganizationResolutionError extends Error {
  constructor(
    readonly code: MemberOrganizationResolutionCode,
    message: string,
  ) {
    super(message);
    this.name = "MemberOrganizationResolutionError";
  }
}

/**
 * Resolve a member-authenticated Team without guessing. An explicit Team must
 * still be one of the caller's active memberships; otherwise use `/me`'s
 * current default, then the sole-membership fallback.
 */
export function resolveMemberOrganizationId(profile: MemberOrganizationProfile, explicitOrg?: string): string {
  const memberships = profile.memberships;
  const requested = explicitOrg?.trim();
  if (explicitOrg !== undefined) {
    if (!requested) {
      throw new MemberOrganizationResolutionError("INVALID_ORG", "--org must be a non-empty organization id");
    }
    if (!memberships.some((membership) => membership.organizationId === requested)) {
      throw new MemberOrganizationResolutionError(
        "ORG_NOT_FOUND",
        `Not an active member of organization "${requested}"`,
      );
    }
    return requested;
  }

  if (
    profile.defaultOrganizationId &&
    memberships.some((membership) => membership.organizationId === profile.defaultOrganizationId)
  ) {
    return profile.defaultOrganizationId;
  }
  if (memberships.length === 1 && memberships[0]) return memberships[0].organizationId;
  if (memberships.length === 0) {
    throw new MemberOrganizationResolutionError("NO_ORG", "You don't belong to any organization");
  }
  throw new MemberOrganizationResolutionError(
    "AMBIGUOUS_ORG",
    "Multiple organizations — pass --org <orgId> explicitly or set a default in the web UI first",
  );
}
