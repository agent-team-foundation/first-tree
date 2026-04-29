import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { invitationRedemptions, invitations } from "../db/schema/invitations.js";
import { organizations } from "../db/schema/organizations.js";
import { NotFoundError } from "../errors.js";
import { uuidv7 } from "../uuid.js";

const TOKEN_BYTES = 32;

function generateInvitationToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Return the *active* invitation for `orgId`, or null if none exists.
 * "Active" = not revoked AND not expired.
 *
 * Mirrors the predicate of the partial UNIQUE index `uq_invitations_active_per_org`,
 * so a successful `getActiveInvitation` is the same row the index protects.
 */
export async function getActiveInvitation(db: Database, orgId: string) {
  const now = new Date();
  const [row] = await db
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.organizationId, orgId),
        isNull(invitations.revokedAt),
        or(isNull(invitations.expiresAt), gt(invitations.expiresAt, now)),
      ),
    )
    .orderBy(desc(invitations.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Get-or-create the active invitation for `orgId`. Idempotent so the admin
 * UI can call this on first render without inadvertently creating a fresh
 * link every time someone visits Settings.
 */
export async function ensureActiveInvitation(db: Database, orgId: string, createdBy: string) {
  const existing = await getActiveInvitation(db, orgId);
  if (existing) return existing;

  const id = uuidv7();
  const token = generateInvitationToken();
  const [row] = await db
    .insert(invitations)
    .values({ id, organizationId: orgId, token, role: "member", createdBy })
    .returning();
  if (!row) throw new Error("Unexpected: INSERT RETURNING produced no row");
  return row;
}

/**
 * Rotate the invitation: revoke the current active row (if any) and insert
 * a new one in a single transaction. Old tokens stop redeeming immediately.
 */
export async function rotateInvitation(db: Database, orgId: string, createdBy: string) {
  return db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(invitations)
      .set({ revokedAt: now })
      .where(and(eq(invitations.organizationId, orgId), isNull(invitations.revokedAt)));

    const id = uuidv7();
    const token = generateInvitationToken();
    const [row] = await tx
      .insert(invitations)
      .values({ id, organizationId: orgId, token, role: "member", createdBy })
      .returning();
    if (!row) throw new Error("Unexpected: INSERT RETURNING produced no row");
    return row;
  });
}

/**
 * Look up an invitation by its public token. Returns null when the token
 * is unknown OR when the row exists but is no longer active. Conflating
 * "unknown" with "revoked" prevents an attacker from inferring which
 * tokens were once valid.
 */
export async function findActiveByToken(db: Database, token: string) {
  const now = new Date();
  const [row] = await db
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.token, token),
        isNull(invitations.revokedAt),
        or(isNull(invitations.expiresAt), gt(invitations.expiresAt, now)),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Public preview surfaced on `/invite/:token` before the recipient signs in.
 */
export async function previewInvitation(db: Database, token: string) {
  const inv = await findActiveByToken(db, token);
  if (!inv) throw new NotFoundError("Invitation not found or no longer valid");

  const [org] = await db
    .select({ id: organizations.id, name: organizations.name, displayName: organizations.displayName })
    .from(organizations)
    .where(eq(organizations.id, inv.organizationId))
    .limit(1);
  if (!org) throw new NotFoundError("Invitation organization not found");

  return {
    organizationId: org.id,
    organizationName: org.name,
    organizationDisplayName: org.displayName,
    role: inv.role,
  };
}

/**
 * Record a redemption row. Caller is responsible for executing the join
 * (members.insert / status='active' flip) — this is the audit trail only.
 */
export async function recordRedemption(
  db: Database,
  data: { invitationId: string; userId: string; ip?: string | null; userAgent?: string | null },
) {
  await db.insert(invitationRedemptions).values({
    id: uuidv7(),
    invitationId: data.invitationId,
    userId: data.userId,
    ip: data.ip ?? null,
    userAgent: data.userAgent ?? null,
  });
}

/**
 * Build the invite URL surfaced to admins. `publicUrl` should be the
 * server's `server.publicUrl` config; pass the request host as fallback in
 * dev where publicUrl may be unset.
 */
export function buildInviteUrl(publicUrl: string, token: string): string {
  const trimmed = publicUrl.replace(/\/+$/, "");
  return `${trimmed}/invite/${token}`;
}
