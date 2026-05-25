/**
 * Predicate: does this org's `displayName` still match the auto-generated
 * default minted by `completeOauthFlow` at OAuth signup?
 *
 * The default minted server-side is `` `${profile.login}'s team` `` (see
 * `packages/server/src/api/auth/github.ts` — passes `profile.login`
 * verbatim, preserving GitHub's original casing). Two independent
 * normalizations break a naive `===` comparison against `user.username`:
 *
 *   - `users.username` is forced lowercase
 *     (`packages/server/src/services/auth-identity.ts` —
 *     `profile.login.toLowerCase()`). A user with GitHub login
 *     `Gandy2025` ends up with `username = "gandy2025"` but a team
 *     `displayName = "Gandy2025's team"`. Mixed-case GitHub logins are
 *     the majority of real users, so a case-sensitive compare here would
 *     silently skip Step 1 for most signups — a hard regression.
 *
 *   - `users.username` may carry a `-<hex4>` disambiguator on UNIQUE
 *     collision while `displayName` keeps the un-suffixed login. This
 *     branch is rare and we accept the false negative — those users land
 *     on a team they didn't personally auto-create (someone else already
 *     held `${their-login}'s team`), so skipping Step 1 silently is
 *     defensible. A future `/me.user.githubLogin` field can clean this up.
 *
 * Lowercasing both sides handles the common (mixed-case) case without
 * paying for the second normalization mismatch.
 */
export function isAutoNamedTeam(teamDisplayName: string | null, login: string | null): boolean {
  if (!teamDisplayName || !login) return false;
  return teamDisplayName.toLowerCase() === `${login.toLowerCase()}'s team`;
}
