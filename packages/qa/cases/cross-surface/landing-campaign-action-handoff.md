---
id: landing-campaign-action-handoff
description: Validate that a campaign result action survives auth and converges on one user-owned task chat across onboarding and direct entry paths.
areas: [cross-surface]
surfaces: [server, web]
---

# Landing Campaign Action Handoff

## Goal

Confirm that a configured landing-campaign result action is never mistaken for
a hosted trial launch. It must survive the OAuth/quickstart boundary, hand the
visible repository and report context to the user's own agent, and converge on
one task chat whether the user reaches it before or after onboarding.

## Operate

Use a public test repository and an unguessable disposable report key. Exercise
the same action URL as a new user and as an already-onboarded user. Re-open it,
then cross from the onboarding path to the direct path. Also try an unknown
action value and a malformed report key. During rollout, repeat one path with a
client that still sends the legacy Production Scan `scanFixRepoSlug` field.

Do not put source contents or report data in hidden prompt metadata. The first
message must be the same visible task text that the agent receives.

## Observe

- The configured action does not call the landing-trial start endpoint; an
  unknown non-empty action also does not start a trial.
- OAuth and onboarding retain only the known campaign, normalized GitHub repo,
  optional validated report key, and repo slug in session-scoped storage.
- Both paths create or reuse one task chat with the configured topic and visible
  repository/report instructions.
- Re-entry, mixed path order, case differences in `owner/repo`, and the legacy
  Production Scan field all resolve to the same Production Scan launcher key.
- A malformed report key degrades to explicit no-report instructions and never
  becomes a path or URL controlled by the caller.

## Expected Result

`PASS` when no trial is launched for an action URL, the user's own agent receives
the visible task, and every valid re-entry converges on one chat. `FAIL` for a
trial launch, duplicate task chats, hidden instructions, cross-repo reuse, or an
unvalidated report URL. `BLOCKED` when OAuth, a user-owned agent, or disposable
report hosting is unavailable.

## Evidence

Keep the redacted action URL, resulting chat IDs and first visible message,
network calls around quickstart/onboarding, and the stored kickoff-key shape.
Never retain auth tokens, cookies, private source, or a live report key.
