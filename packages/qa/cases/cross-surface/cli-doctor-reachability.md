---
id: cli-doctor-cross-process-reachability
description: Verify the built dist CLI `doctor` reaches a running server over HTTP and a real WebSocket connection and reports a coherent readiness snapshot.
areas: [cross-surface]
surfaces: [cli, server]
---

# CLI Doctor Cross-Process Reachability

## Goal

Confirm the built dist CLI binary reaches a running server across process lines — HTTP reachability plus a real
WebSocket connection — via the credentials-free `doctor` readiness command. This exercises two layers
`system/cloud/release/verification.md` marks as unguarded by automated tests: CLI handoff through the built dist binary,
and the HTTP + WebSocket protocol boundary.

Use this case for release-candidate QA when CLI-to-server reachability or the WebSocket upgrade path matters. It is a
reachability smoke, not a full authenticated-session or agent-turn test.

## Preconditions

- Isolated run cell with the server running (see `release-boot-health`) and the CLI built from the target ref.
- The CLI runtime can resolve the server host — same Docker network with `FIRST_TREE_SERVER_URL` set, or `--server`.
- No login, agent, or provider credentials required. `doctor`'s server, WebSocket, and provider-detection checks are
  credential-free; the agent and background-service checks are expected to report not-configured in a fresh run cell.

## Operate

- `operate cli-command`: run the built dist CLI `doctor` with the server URL configured, e.g.
  `FIRST_TREE_SERVER_URL=http://server:8000 node apps/cli/dist/cli/index.mjs doctor`.

If the CLI is an installed package rather than an in-tree dist build, run the packaged `doctor` subcommand instead and
record the exact invocation in the plan and report.

## Observe

- `observe command-output`: `doctor` reports, at minimum:
  - Node.js version check passes;
  - config resolves (config file + env vars);
  - Server URL check passes for the configured server;
  - **WebSocket** check passes with a real `ws://<server>` connection reported reachable;
  - provider capability checks resolve (bundled or path per provider);
  - Agents and Background service are reported as not-configured in a fresh, unlogged-in run cell — expected state, not a
    product failure.
- `observe command-output`: the command exits 0 even when it prints expected no-login "issues" (agents / background
  service).

If the readiness report format changes during product work, follow the current output but keep the evidence focused on
the same behavior: the dist CLI reaches the server over HTTP and WebSocket and reports coherent readiness.

## Expected Result

`PASS`: the dist CLI reached the server over HTTP and opened a real WebSocket to it, and the server / WebSocket / provider
checks are healthy; the agent and background-service "issues" are the expected no-login state, not product defects.

`FAIL`: a reproducible product defect — the CLI cannot reach a healthy server, the WebSocket check fails against a healthy
server, config fails to resolve, or `doctor` crashes.

`BLOCKED`: the CLI cannot be built, or the server is not running in the run cell.

`INCONCLUSIVE`: output was partial, unstable, or not attributable to the target ref.

## Evidence

Keep the full `doctor` output, including the server URL and WebSocket lines and the exit status. Redact any tokens or
credentials before sharing outside the run.
