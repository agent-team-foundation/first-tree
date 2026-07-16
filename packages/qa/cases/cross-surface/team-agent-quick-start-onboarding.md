---
id: team-agent-quick-start-onboarding
description: Validate the invitee get-started fork end to end — install-free quick start in a teammate's org-visible agent chat with an invitee_skip stamp and no completion, plus the resumable and safely pausable standard-setup journey.
areas: [cross-surface]
surfaces: [server, web]
---

# Team-Agent Quick Start Onboarding

## Goal

Confirm the install-free invitee path across server and web: a member who joins a team that already runs a teammate's
org-visible agent is offered the `get-started` fork after join-team, can quick-start into that agent's ordinary kickoff
chat without connecting a computer or creating a personal agent, lands in the workspace with only the `invitee_skip`
suppressor written (never completion), and can later resume — and safely pause again — the standard
connect-computer → create-agent journey from Settings → Setup.

Deterministic product tests own the stamp guard semantics, fork rendering, picker filtering/pagination, and copy. This
case owns the live boundaries those tests cannot prove: the real kickoff round-trip (chat creation, bootstrap delivery,
agent wake on the owner's runtime), the `/me`-refresh-then-navigate ordering that keeps the workspace gate from
bouncing the member back, cross-tab/reload behavior of the suppressed-but-incomplete membership, and the resumed-setup
pause path.

## Preconditions

- An isolated server stack with two users in one organization:
  - **Owner**: admin or member with a connected client and an active org-visible (`visibility=organization`) non-human
    agent bound to a live runtime.
  - **Invitee**: a fresh member (joined via invite link) with no connected client and no personal agent, so
    `currentOrgHasUsableAgent=true` and `currentOrgHasPersonalAgent=false` for the selected membership.
- A second fresh member in a team with NO org-visible agent, for the negative path.

## Scenario

1. **Fork appears only when it should.** Sign in as the invitee, land in `/onboarding` (invitee path), finish
   join-team. Expect the get-started fork: "Set up my own agent" (primary) and "Take a quick look with a team agent".
   In the no-shareable-agent team, expect join-team to advance straight to connect-computer with no fork flash and no
   step skipped (connect-computer, not create-agent, is next).
2. **Quick start.** Take the quick start, expect the picker to list the owner's agent as "Run by 〈owner display
   name〉" plus the footnote that setup is not finished. Start the chat. Expect: navigation to the workspace with that
   chat open and NO bounce back into `/onboarding`; the bootstrap renders as the member-voice opening message; the
   owner's agent wakes and replies as a get-settled welcome (welcome-skill routing intact).
3. **State is suppressed, never completed.** Verify the membership row: `onboarding_suppressed_reason='invitee_skip'`,
   `onboarding_suppressed_at` set, `onboarding_completed_at` NULL. Reload the workspace root — the member stays in the
   workspace. Re-running the quick start for the same agent converges on the same chat (idempotent kickoff), sends no
   duplicate bootstrap, and never rewrites the existing stamp.
4. **Offline disclosure.** Stop the owner's runtime, send another message in the quick-start chat as the invitee.
   Expect the offline notice to say the agent runs on a teammate's computer, with NO "Reconnect" action. As the owner
   in one of their own chats, the notice keeps the Reconnect action.
5. **Resume and safe pause.** As the invitee, open Settings → Setup and resume. Expect to re-enter onboarding at the
   standard journey with "I'll finish later" AVAILABLE (the team-agent workspace is a usable destination). Click it —
   expect a return to the workspace with the quick-start chat intact, no onboarding bounce loop, and the membership
   re-suppressed. Resume again and complete connect-computer → create-agent → start-chat for real; expect
   `onboarding_completed_at` to be written now and the completion to upgrade (not conflict with) the earlier
   `invitee_skip` stamp.

## Non-goals

Provider-side agent output quality, the landing-campaign trial path, and admin onboarding are out of scope. The
picker's >100-agent pagination is covered by deterministic tests; this case does not require a 100-agent org.
