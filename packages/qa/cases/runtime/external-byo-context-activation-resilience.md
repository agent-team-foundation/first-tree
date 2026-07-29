---
id: runtime-external-byo-context-activation-resilience
description: Validate fail-closed BYO Context activation across provider hooks and explicit CLI operations under transient authority failures.
areas: [runtime]
surfaces: [cli, client]
---

# External BYO Context Activation Resilience

## Goal

Confirm that a user-scoped Claude Code or Codex Context Plugin activates only for
the exact enabled checkout, remains within the provider hook's execution budget,
and gives explicit Context operations a bounded recovery path when live authority
is temporarily slow or unavailable.

Use this case for release qualification when SessionStart behavior, activation
latency, or live authority resilience changes. Stable retry classification and
timeout values belong in product tests; this case validates the real provider,
installed Plugin, CLI artifact, network boundary, and user-visible behavior
together.

## Preconditions

- Run the target release artifact in an isolated QA cell with a real supported
  Claude Code or Codex provider bridge.
- Install the Context Plugin through the real user-scope lifecycle and enable it
  for one exact source checkout through a Team-scoped handoff.
- Keep a second checkout of the same repository unbound as a negative control.
- Use only throwaway Team/repository data and credentials. Do not reuse or mutate
  an operator's Plugin installation, account state, or checkout binding.
- Establish provider readiness with `runtime-provider-readiness` before treating
  a hook transcript as product evidence.

## Operate And Observe

- Start, resume, clear, and compact a provider session in the bound checkout.
  Observe the real SessionStart hook transcript and measure end-to-end hook time.
- Repeat in the unbound checkout and confirm no Team Context is injected.
- Exercise `context status`, guarded Read, and guarded Write preflight through the
  shipped CLI artifact while the activation endpoint is healthy.
- Repeat with an access token that requires refresh. Introduce slow refresh,
  refresh-network, and refresh-5xx conditions and confirm they consume the same
  per-attempt budget and retry policy as the validator request rather than
  extending the operation behind the provider hook.
- Introduce controlled transient authority conditions for timeout, network
  failure, and server 5xx. Verify an explicit operation retries only the same
  exact Team and repository, at most once, and reports a stable safe reason if it
  still cannot activate.
- Introduce authentication/authorization failure, a client 4xx, revoked
  membership, and repository-scope removal. Verify these do not retry as
  transient failures and do not fall back to another Team or cached authority.
- Make live authority slower than the SessionStart internal budget. Confirm the
  provider hook completes within its outer budget with a controlled unavailable
  result, normal coding remains usable, and no Context is injected.

Record provider version, Plugin release digest, bound checkout identity, exact
Team identifier, hook transcript, operation output, endpoint fault used, attempt
count, and latency. Redact credentials and private Context content.

## Expected Result

`PASS`: bound healthy sessions inject the exact Team Context; unbound sessions
remain inactive; SessionStart always returns within the provider hook budget;
explicit operations make only the allowed same-target transient retry; and every
unresolved authority failure remains fail closed with a stable actionable
classification.

`FAIL`: a hook is killed by its outer timeout under a valid supported latency
condition, an explicit operation exceeds its retry bound, a non-transient failure
is retried, cached or alternate-Team authority is used, or unavailable authority
still permits Read/Write.

`BLOCKED`: the provider cannot be made one-turn-ready, the Plugin cannot be
installed in the isolated environment, or controlled authority faults cannot be
introduced without changing shared production state.

`INCONCLUSIVE`: timing or retry evidence is incomplete, the failure cannot be
attributed to the target release, or provider and authority failures overlap in a
way that prevents classification.
