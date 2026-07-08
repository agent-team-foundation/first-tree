/**
 * The landing-campaign (Scan) trial funnel renders the real workspace shell at
 * this path, gate-free (see `app.tsx` + `WorkspaceBody`). The trial is a
 * single-run, controlled surface — the tree's Landing Campaign Trial Runtime
 * makes the trial chat the only supported user-facing chat surface — so on this
 * route the shell drops the escape hatches a normal workspace has (nav tabs,
 * team switcher, command palette, conversation rail) and shows one intentional
 * "set up First Tree" conversion CTA instead.
 *
 * Keying trial chrome off the ROUTE keeps it out of `shouldEnterOnboarding`
 * (which stays pure/campaign-agnostic) and off the trial agent's identity.
 */
export const QUICKSTART_PATH = "/quickstart";

export function isLandingTrialSurface(pathname: string): boolean {
  return pathname === QUICKSTART_PATH;
}
