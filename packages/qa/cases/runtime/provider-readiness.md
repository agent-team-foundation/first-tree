---
id: runtime-provider-readiness
description: Verify provider readiness before using real agent behavior as QA evidence.
areas: [runtime]
surfaces: [client, cli]
---

# Runtime Provider Readiness

## Goal

Confirm that a runtime QA run has enough provider readiness to treat real agent behavior as product evidence.

Use this case only when runtime or agent-turn behavior is in scope. Do not select it for CLI, API, or web-only validation
where no provider-backed turn is needed.

## Checklist

- Identify which provider and runtime path the task needs.
- Check provider binary availability inside the run cell, not only on the host.
- Check launchability with the provider's own doctor, version, smoke, or startup command when available.
- Check auth/session readiness before running a real agent turn.
- Bridge only the minimum credential or state material needed for the run, preferably read-only.
- Run a minimal real turn when the QA conclusion depends on agent behavior.
- Treat missing auth, non-launchable providers, or unavailable Linux-compatible binaries as `BLOCKED` for runtime
  behavior, not as product `FAIL`.

## Evidence

Credible evidence can include provider version output, doctor output, launch logs, runtime logs, a minimal turn transcript,
or a recorded reason that readiness could not be established. Do not paste secrets, tokens, cookies, provider credentials,
or private session data into the report.

## Expected Result

For real agent behavior, readiness needs to reach `one-turn-ready`: the provider can launch in the run cell and complete a
minimal authenticated turn. `binary-detected` or `binary-launchable` can be useful setup evidence, but they are not enough
to pass a case whose conclusion depends on agent behavior.
