---
id: daemon-probe-runtime-capability
description: Validate that daemon probe reports runtime provider source and path through a credentials-free local CLI probe.
areas: [runtime]
surfaces: [cli]
---

# Daemon Probe Runtime Capability

## Goal

Verify that the local CLI can probe runtime provider capability on demand and report enough source/path detail to explain
which provider binary would be used by a daemon-backed run.

Use this case when a task depends on runtime provider discovery, daemon readiness, or a concrete CLI operate -> observe ->
assert example. Do not use it as a substitute for a real authenticated turn when the QA question depends on agent
behavior.

## Preconditions

- Run inside the isolated QA run cell selected by the plan.
- Use the repository CLI entrypoint or built package that the task under test requires.
- Choose a run cell where at least one expected provider can be installed or exposed. If no provider can be launched in
  the run cell, mark the positive-path case `BLOCKED`; do not convert missing local setup into product `FAIL`.
- Do not rely on server credentials for this case.

## Operate

Run the daemon probe without upload:

```sh
first-tree daemon probe --json --no-upload
```

If the task needs a different package manager wrapper or local binary path, record the exact command in the QA plan and
report.

## Observe

The command should produce a JSON result envelope on stdout. For the provider being validated, inspect the capability
entry rather than only checking process exit status:

- the envelope is parseable JSON;
- the result is successful for the provider selected by the plan;
- the provider capability includes availability/state detail;
- `runtimeSource` explains whether the provider came from a bundled runtime or a binary found on `PATH`;
- `runtimePath` is consistent with `runtimeSource` (for example, a path string for `runtimeSource: "path"`, or `null`/omitted
  when a bundled runtime does not expose a host path);
- the no-upload run does not fail because server auth, upload credentials, or an active First Tree session is missing.

If the output shape changes during product work, follow the product's current typed schema, but keep the evidence focused
on the same behavior: the CLI probe must make provider availability and source/path provenance observable without an
upload.

## Expected Result

`PASS` means the probe completed in the run cell, the selected provider's capability entry showed a usable runtime source
and matching path/provenance detail, and the no-upload mode did not require server credentials.

`FAIL` means the CLI reproducibly returned incorrect provider provenance, required upload/auth despite `--no-upload`, or
reported success while omitting the source/path detail needed to debug provider selection.

`BLOCKED` means the run cell could not expose any provider or the CLI under test could not be built/launched.

`INCONCLUSIVE` means output was partial, unstable, or not attributable to the target ref.

## Evidence

Keep the command, exit status, parsed JSON snippet for the selected provider, and any provider binary/version notes. Redact
host-specific secrets and do not upload provider credentials.
