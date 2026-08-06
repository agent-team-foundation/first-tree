---
id: external-context-hook-status
description: Validate Codex Context enable consent guidance and layered status across provider, Plugin, Hook, project, binding, and live Team activation.
areas: [cross-surface]
surfaces: [cli, codex, server]
---

# External Context Hook Consent And Layered Status

## Goal

Confirm that the shipped CLI never bypasses Codex Hook consent, guides a person
through the first enable flow, then reads the provider's real SessionStart
trust and enabled state without conflating machine Plugin state with
project/Team activation.

## Preconditions

- Use the formal isolated QA run cell and a disposable ordinary parent
  directory containing two Git repositories; do not use the product worktree
  as the experience fixture.
- Bridge to a supported host Codex installation using a throwaway
  `CODEX_HOME`. The run must exercise the real Codex Plugin lifecycle,
  interactive `/hooks` surface, and app-server `hooks/list` response.
- Use a staging First Tree account and disposable Team with a ready Context
  Tree. Keep both source repositories absent from Team resources. Keep
  credentials outside committed artifacts and redact the Team id if the
  evidence leaves the QA environment.
- Begin once with no Hook trust state and once with an already trusted and
  enabled First Tree SessionStart Hook.

## Operate

- Run the Team-authored `context enable --provider codex ... --plan` handoff
  with the ordinary parent as `--project-root`, choose directory, and apply the
  selected choice's exact CLI-authored `applyCommand` unchanged.
- Follow only the displayed consent steps: open Codex, run `/hooks`, find First
  Tree Context → SessionStart, enable it, trust it, return to the original
  conversation, and reply `continue` without starting a new session.
- Confirm the same coding agent re-runs the exact Team-authored enable command
  after consent, in human and JSON modes; capture its `Setup:` verdict line,
  next actions, Team Context block, and `currentSessionHandoff`.
- Run `context status --provider codex` in human and JSON modes before consent,
  after enabling without trust, and after trust in the same session.
- Disable the Hook while retaining trust, then change the installed Hook
  definition so Codex reports modified trust; inspect status after each state.
- Repeat enable with the already trusted and enabled Hook.
- Repeat in a projectless Codex scratch directory. Confirm the plan returns
  only global and session choices, has no directory choice or directory apply
  command, then choose session-only and confirm setup completes without Plugin
  installation or Hook consent.

## Observe

- Enable never passes a trust-bypass flag or writes trusted Hook state. Its
  `nextActions` gives the `/hooks` path as ordered, verifiable steps; the Web
  prompt does not carry a second copy of those recovery instructions.
- Enable ends with one literal verdict line: `Setup: Complete` only when every
  layer including provider compatibility and payload health is green, otherwise
  `Setup: Incomplete — <missing layers>` with an actionable recovery step for
  every red layer (never an empty next-step list). Before Hook consent the
  verdict is `Incomplete`; after consent, re-running enable is what produces
  `Setup: Complete`.
- On connected live activation, enable prints the same Team Context block a
  SessionStart injects (JSON `activationContext`) and returns a non-null
  `currentSessionHandoff` with the same bytes and all three verified Skill
  entries. The `setup` object in JSON mirrors the verdict; Complete never
  coexists with a null handoff.
- Before Hook consent the handoff is null. Consent guidance returns the member
  to the original conversation and never asks for exit, restart, or a new
  session.
- Provider compatibility, Plugin installed, Plugin enabled, Hook trusted, Hook
  enabled, project, applicable grants, and live activation are separate fields in
  human and JSON output.
- Codex `trusted + enabled` renders Hook trusted/enabled as `Yes`; repeating
  enable does not incorrectly ask for another review.
- Trusted but disabled, untrusted, and modified Hook states remain distinct and
  include the correct `/hooks` repair action.
- Applicable grants remain visible when live activation is unavailable; no
  cached Team authority is presented as connected.
- The ordinary non-Git parent and both nested repositories resolve all Teams at
  the same deepest directory root without Git remote inspection.
- A Codex scratch path is shown as a real temporary directory with a warning;
  its plan contains only global and session choices, and session-only does not
  auto-activate a future session.

## Expected Result

`PASS`: all state transitions are read from real provider/server surfaces,
consent remains provider-owned, trusted/enabled state is reported accurately,
and every status layer and project-resolution failure stays distinct.

`FAIL`: status claims review is required after Codex reports trusted, conflates
Hook enablement with Plugin enablement, hides applicable grants when the server
is unavailable, merges project-resolution failures, bypasses consent, or
reports live activation for another project/Team.

`BLOCKED`: the isolated Codex bridge, staging account, disposable Team scope, or
ordinary multi-repository project fixture cannot be prepared.

`INCONCLUSIVE`: only source/tests/mocks were observed, the provider state could
not be captured, or the state transition evidence is incomplete.

## Evidence

Keep the enable/status human output, redacted JSON envelopes, Codex `/hooks`
screenshots for each state, the matching `hooks/list` rows, SessionStart output,
and server activation response/log correlation. Record provider and CLI
versions, the bound project path, and the disposable source-repository commits.
