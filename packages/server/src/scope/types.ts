/**
 * Scope types — what each route helper returns after gating the request.
 *
 * `UserScope` carries only the JWT-verified `userId`. Anything beyond that
 * (org, role, human-agent) requires a real-time DB probe via the `OrgScope`
 * helpers in `require-org.ts` and `require-resource.ts`.
 *
 * The split is deliberate: it makes "scope = JWT" a hard type-level
 * impossibility, killing the JWT-ambient-scope bug class (#220 / #222 /
 * #238 / #239) at compile time.
 */

export type UserScope = {
  userId: string;
};

export type OrgScope = {
  userId: string;
  /** The org from the URL `:orgId` param (for Class B) or the resource's
   * own org (for Class C). Named `organizationId` to match the DB column. */
  organizationId: string;
  memberId: string;
  role: "admin" | "member";
  /** The user's HUMAN agent in this org (for chat creation, etc.) */
  humanAgentId: string;
};
