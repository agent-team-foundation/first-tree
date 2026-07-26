---
id: codex-reasoning-effort
description: Verify Codex agents preserve provider-native max and ultra effort without local downgrade.
areas: [runtime]
surfaces: [web, cli, server, client]
---

# Codex Reasoning Effort

## Goal

Confirm that a Codex agent can save and run with the provider-native `max` and `ultra` reasoning-effort values, while
leaving model compatibility and rejection behavior to the provider.

Use this case when agent runtime configuration or Codex effort forwarding changes. Pair it with the runtime-provider
readiness case because credible positive-path evidence requires a real authenticated Codex turn.

## Preconditions

- Run in the isolated QA run cell selected by the plan.
- Use a Codex CLI/app-server version that advertises `max` and `ultra` support.
- Select models/accounts that the live provider reports as compatible with each value. If a compatible model is not
  available in the run cell, mark that value `BLOCKED`, not product `FAIL`.
- Do not change the production agent or the operator's persistent Codex configuration.

## Checklist

- Save `max` through one First Tree configuration surface and `ultra` through the other (Web and CLI), then read the
  effective agent config back to confirm each literal was preserved.
- Start a fresh provider session after each change; do not treat an already-running session as evidence because effort
  changes apply at session bootstrap.
- Complete a minimal real turn at each supported effort and capture enough runtime/provider evidence to distinguish the
  selected value from a local downgrade to `xhigh` or `high`.
- If the run cell has a known unsupported model/value combination, verify that the provider rejection is surfaced
  explicitly through the existing failure path and that First Tree does not silently retry with a lower effort.
- Recover by choosing a compatible model or lower effort and starting a fresh session.

## Expected Result

`PASS` means `max` and `ultra` both round-trip unchanged through First Tree configuration and reach successful real Codex
turns on compatible models, with no evidence of local aliasing or downgrade. If a reliable negative branch is available,
the incompatible combination must fail visibly and recover after an explicit config change.

`FAIL` means First Tree rejects a provider-supported value, rewrites it to another effort, applies it only on one runtime
path, silently downgrades an incompatible value, or leaves the user without the existing provider-failure recovery path.

`BLOCKED` means provider binary, authentication, account entitlement, or compatible model availability prevents a real
turn. `INCONCLUSIVE` means the value round-trips but the run cannot prove which effort reached the provider.

## Evidence

Keep the provider version/model catalog evidence, config write/readback, the fresh-session boundary, one minimal turn per
supported value, and the relevant runtime/provider trace or observable response. Redact credentials and private session
content.
