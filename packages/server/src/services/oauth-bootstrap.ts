import { isKnownLandingCampaignSlug } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { users } from "../db/schema/users.js";
import { findActiveByToken, recordRedemption } from "./invitation.js";
import { createPersonalTeam, ensureMembership, pickPrimaryMembership } from "./membership.js";

export type ExternalAccountBootstrapUser = {
  userId: string;
  username: string;
  displayName: string;
  created: boolean;
};

export type ExternalAccountBootstrapInput = {
  next: string;
  allowedOrganizationId: string | null;
  ip: string | null;
  userAgent: string | null;
};

export type ExternalAccountBootstrapResult = {
  account: ExternalAccountBootstrapUser;
  joinPath: "invite" | "solo" | "returning";
  next: string;
  organizationId: string;
  orgPinned: boolean;
  teamCreated: boolean;
};

export const OAUTH_BOOTSTRAP_ERROR_CODES = ["invite-invalid", "invite-not-allowed", "invite-required"] as const;
export type OAuthBootstrapErrorCode = (typeof OAUTH_BOOTSTRAP_ERROR_CODES)[number];

export class OAuthBootstrapError extends Error {
  readonly code: OAuthBootstrapErrorCode;

  constructor(code: OAuthBootstrapErrorCode) {
    super(code);
    this.name = "OAuthBootstrapError";
    this.code = code;
  }
}

export async function completeExternalAccountBootstrap(
  db: Database,
  account: ExternalAccountBootstrapUser,
  input: ExternalAccountBootstrapInput,
): Promise<ExternalAccountBootstrapResult> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const [lockedUser] = await txDb
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, account.userId))
      .for("update")
      .limit(1);
    if (!lockedUser) throw new Error("External account bootstrap references a missing user");

    // Serializing on the stable user row keeps two first sign-ins from both
    // observing an empty membership set and creating separate personal teams.
    const inviteMatch = /^\/invite\/([^/?#]+)/.exec(input.next);
    if (inviteMatch?.[1]) {
      const invitation = await findActiveByToken(txDb, inviteMatch[1]);
      if (!invitation) throw new OAuthBootstrapError("invite-invalid");
      if (input.allowedOrganizationId && invitation.organizationId !== input.allowedOrganizationId) {
        throw new OAuthBootstrapError("invite-not-allowed");
      }
      await ensureMembership(txDb, {
        userId: account.userId,
        organizationId: invitation.organizationId,
        role: invitation.role === "admin" ? "admin" : "member",
        displayName: account.displayName,
        username: account.username,
      });
      await recordRedemption(txDb, {
        invitationId: invitation.id,
        userId: account.userId,
        ip: input.ip,
        userAgent: input.userAgent,
      });
      return {
        account,
        joinPath: "invite",
        next: "/",
        organizationId: invitation.organizationId,
        orgPinned: true,
        teamCreated: false,
      };
    }

    const primary = await pickPrimaryMembership(txDb, account.userId);
    if (primary) {
      return {
        account,
        joinPath: "returning",
        next: input.next,
        organizationId: primary.organizationId,
        orgPinned: false,
        teamCreated: false,
      };
    }

    if (input.allowedOrganizationId) throw new OAuthBootstrapError("invite-required");

    const team = await createPersonalTeam(txDb, {
      userId: account.userId,
      username: account.username,
      teamDisplayName: personalTeamDisplayName(account.displayName),
      userDisplayName: account.displayName,
    });
    return {
      account,
      joinPath: "solo",
      next: shouldPreserveSoloSignupNext(input.next) ? input.next : "/",
      organizationId: team.organizationId,
      orgPinned: true,
      teamCreated: true,
    };
  });
}

export function shouldPreserveSoloSignupNext(next: string): boolean {
  const parsed = new URL(next, "http://first-tree.local");
  return parsed.pathname === "/quickstart" && isKnownLandingCampaignSlug(parsed.searchParams.get("campaign"));
}

export function personalTeamDisplayName(displayName: string): string {
  return `${displayName.slice(0, 193)}'s team`;
}
