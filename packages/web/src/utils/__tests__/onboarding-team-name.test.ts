import { describe, expect, it } from "vitest";
import { isAutoNamedTeam } from "../onboarding-team-name.js";

describe("isAutoNamedTeam", () => {
  it("matches the all-lowercase login case (post-OAuth happy path)", () => {
    // First user from GitHub login `octocat`: username and teamDisplayName
    // both lowercase, exact match.
    expect(isAutoNamedTeam("octocat's team", "octocat")).toBe(true);
  });

  it("matches when the GitHub login was mixed-case (the PR #377 regression case)", () => {
    // GitHub login `Gandy2025` → `users.username = "gandy2025"` (forced
    // lowercase by `auth-identity.ts`) but
    // `team.displayName = "Gandy2025's team"` (original casing preserved
    // by `github.ts::completeOauthFlow`). A case-sensitive `===` here
    // would silently skip Step 1 for the majority of real users —
    // mixed-case GitHub logins are the norm, not the exception.
    expect(isAutoNamedTeam("Gandy2025's team", "gandy2025")).toBe(true);
    expect(isAutoNamedTeam("OctoCat's team", "octocat")).toBe(true);
  });

  it("returns false once the admin has renamed the team", () => {
    // The whole point of Step 1: detect the un-renamed default. Any
    // non-default value falls through to Step 2 silently.
    expect(isAutoNamedTeam("Acme Inc", "octocat")).toBe(false);
    expect(isAutoNamedTeam("octocat's renamed team", "octocat")).toBe(false);
  });

  it("returns false for an invitee whose admin has the auto-named team", () => {
    // Member `alice` joined `octocat`'s still-default team. The gate
    // should NOT fire — invitees aren't the team's owner. The caller
    // additionally guards on `role === "admin"`, but the predicate is
    // also correct on its own because the team name doesn't reference
    // the invitee's login.
    expect(isAutoNamedTeam("octocat's team", "alice")).toBe(false);
  });

  it("returns false when the username collision suffix breaks the match", () => {
    // Username collision path (`auth-identity.ts:181-208`): a second
    // `octocat` becomes `octocat-a3f2` but their team was still minted
    // as `octocat's team` (without suffix — see `github.ts` passes
    // `profile.login` verbatim). The predicate intentionally returns
    // false here: silently skipping Step 1 for the collision branch is
    // accepted (the user landed on a team another `octocat` already
    // owned by name; nagging them to rename it isn't the right UX).
    // Future fix: surface a separate `githubLogin` field on `/me.user`.
    expect(isAutoNamedTeam("octocat's team", "octocat-a3f2")).toBe(false);
  });

  it("returns false when either input is null or empty", () => {
    expect(isAutoNamedTeam(null, "octocat")).toBe(false);
    expect(isAutoNamedTeam("octocat's team", null)).toBe(false);
    expect(isAutoNamedTeam(null, null)).toBe(false);
    expect(isAutoNamedTeam("", "octocat")).toBe(false);
    expect(isAutoNamedTeam("octocat's team", "")).toBe(false);
  });
});
