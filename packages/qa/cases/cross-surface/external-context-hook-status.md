---
id: external-context-hook-status
description: Validate Codex Context enable consent guidance and layered status across provider, Plugin, Hook, checkout, binding, and live Team activation.
areas: [cross-surface]
surfaces: [cli, codex, server]
---

# External Context Hook Consent And Layered Status

## Goal

Confirm that the shipped CLI never bypasses Codex Hook consent, guides a person
through the first enable flow, then reads the provider's real SessionStart
trust and enabled state without conflating machine Plugin state with
repository/Team activation.

## Preconditions

- Use the formal isolated QA run cell and a disposable ordinary Git repository
  with a readable GitHub `origin`; do not use the product checkout as the
  experience fixture.
- Bridge to a supported host Codex installation using a throwaway
  `CODEX_HOME`. The run must exercise the real Codex Plugin lifecycle,
  interactive `/hooks` surface, and app-server `hooks/list` response.
- Use a staging First Tree account and disposable Team/repository scope. Keep
  credentials outside committed artifacts and redact the Team id if the
  evidence leaves the QA environment.
- Begin once with no Hook trust state and once with an already trusted and
  enabled First Tree SessionStart Hook.

## Operate

- Run the Team-authored `context enable --provider codex` handoff from the
  disposable checkout.
- Follow only the displayed consent steps: open Codex, run `/hooks`, find First
  Tree Context → SessionStart, enable it, trust it, and start a new session.
- Re-run the same Team-authored enable command after consent, in human and JSON
  modes; capture its `Setup:` verdict line, next actions, and Team Context
  block.
- Run `context status --provider codex` in human and JSON modes before consent,
  after enabling without trust, after trust, and after starting the new
  session.
- Disable the Hook while retaining trust, then change the installed Hook
  definition so Codex reports modified trust; inspect status after each state.
- Repeat enable with the already trusted and enabled Hook.
- Separately inspect status while signed out, outside any Git repository, and
  inside a signed-in Git repository with no readable `origin`.

## Observe

- Enable never passes a trust-bypass flag or writes trusted Hook state. Its
  output gives the `/hooks` path as ordered, verifiable steps.
- Enable ends with one literal verdict line: `Setup: Complete` only when every
  layer including provider compatibility and payload health is green, otherwise
  `Setup: Incomplete — <missing layers>` with an actionable recovery step for
  every red layer (never an empty next-step list). Before Hook consent the
  verdict is `Incomplete`; after consent, re-running enable is what produces
  `Setup: Complete`.
- On connected live activation, enable prints the same Team Context block a
  SessionStart injects (JSON `activationContext`), headed by the instruction to
  adopt it in the current session; the `setup` object in JSON mirrors the
  verdict.
- Provider compatibility, Plugin installed, Plugin enabled, Hook trusted, Hook
  enabled, checkout, exact binding, and live activation are separate fields in
  human and JSON output.
- Codex `trusted + enabled` renders Hook trusted/enabled as `Yes`; repeating
  enable does not incorrectly ask for another review.
- Trusted but disabled, untrusted, and modified Hook states remain distinct and
  include the correct `/hooks` repair action.
- The exact checkout binding remains visible when live activation is
  temporarily unavailable; no cached Team authority is presented as
  connected.
- Signed out, non-Git directory, and missing `origin` each retain their actual
  cause and a specific repair action.
- A new Codex session runs SessionStart and reports live activation connected
  only for the exact disposable checkout binding.

## Expected Result

`PASS`: all state transitions are read from real provider/server surfaces,
consent remains provider-owned, trusted/enabled state is reported accurately,
and every status layer and checkout failure stays distinct.

`FAIL`: status claims review is required after Codex reports trusted, conflates
Hook enablement with Plugin enablement, hides the exact binding when the server
is unavailable, merges checkout failures, bypasses consent, or reports live
activation for another checkout/Team.

`BLOCKED`: the isolated Codex bridge, staging account, disposable Team scope, or
ordinary repository fixture cannot be prepared.

`INCONCLUSIVE`: only source/tests/mocks were observed, the provider state could
not be captured, or the state transition evidence is incomplete.

## Evidence

Keep the enable/status human output, redacted JSON envelopes, Codex `/hooks`
screenshots for each state, the matching `hooks/list` rows, SessionStart output,
and server activation response/log correlation. Record provider and CLI
versions and the disposable checkout commit.
