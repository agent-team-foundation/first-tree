---
id: external-context-current-session-handoff
description: Validate thin-Plugin migration, exact-release Core loading, concise setup recovery, Claude next-session adoption, and safe current-session handoff.
areas: [cross-surface]
surfaces: [web, server, cli, claude-code, codex, context-tree]
---

# External Context Current-Session Handoff

## Goal

Confirm that Codex can install the thin First Tree Context Plugin, complete
provider-owned consent, and load the current CLI release's canonical Core
workflow in the same conversation. Confirm Claude setup accurately waits for a
new session instead of returning a blocked handoff. Prove that a later Core-only
CLI upgrade needs no Plugin reinstall, Claude lifecycle action, or repeated
Codex trust.

## Preconditions

- Use isolated disposable provider homes, a staging member, and a disposable
  Team with a uniquely identifiable Context Tree decision.
- Prepare both no-Plugin and legacy full-Plugin provider states. Keep an older
  same-channel CLI earlier on `PATH` while Web bootstrap installs the current
  portable exact-version release.
- Prepare attached, pathless, expired-login, transient-network, local Plugin
  drift, account-switch, and missing-permission fixtures. Redact credentials,
  receipts, internal paths, and private Tree content.

## Operate

1. Paste the Web bootstrap prompt into each already-running provider. Verify
   normal progress mentions only checking, installing/updating, required user
   action, and completion; it must not narrate commands or expose raw JSON,
   plan ids, digests, receipts, journals, Plugin cache paths, or Hook internals.
2. Inject one retryable timeout and one reversible local Plugin drift. Confirm
   the agent retries the exact transient action no more than twice, or runs only
   the CLI-provided exact repair/retry action, then rechecks the original step.
3. Exercise scope choice, account-switch consent, login/auth/permission, Codex
   Hook trust, destructive reset, and a changed plan. Confirm the agent always
   stops for the user at these boundaries and never hand-edits provider cache,
   Context config, receipts, or journals.
4. Install or migrate Claude. Confirm apply completes with
   `currentSessionHandoff: null`, does not provide a Read loader or claim that
   Context is active in the current conversation, and tells the user that
   persistent automatic routing begins in the next session. Confirm the Plugin contains only SessionStart lifecycle logic,
   no same-session adoption hook or receipt path, and the general Skill loader
   creates no lifecycle state. Start a new session and verify its exact
   SessionStart consumes the obligation before routing.
5. Install Codex, complete `/hooks` trust in the same conversation, then rerun
   the same apply command. Repeat with an already trusted Hook.
6. Inspect the complete schema-v3 handoff. Trigger two Read tasks and then a
   Write task. Every task must run its loader anew. With unchanged digests,
   confirm the second Read does not reread either full Core file, and the first
   Write reads its distinct Skill once while reusing the already-read Policy.
   Confirm there is no independent hash command or persistent Core cache.
   Change cwd before first Read and prove the immutable provider/project receipt
   still governs routing.
7. Upgrade to CLI releases that change only the Core Skill digest and only the
   Policy digest while adapter bytes and `adapterVersion` are unchanged. In each
   new task, confirm the loader returns the new exact release paths and digests
   and only the changed or unavailable content is reread. Simulate startup,
   resume, clear, or compact without the previous full text and confirm both
   items are reread. A matching path, name, release version, or summary must not
   authorize reuse. Do not reinstall or reload the Plugin; Codex trust remains
   trusted.
8. Invoke the legacy full Plugin's retired `context read` against the new CLI.
   Confirm typed `CONTEXT_PLUGIN_RELOAD_REQUIRED` and no Tree read. Tamper a
   Core file, symlink a Core path outside the exact release, and remove an old
   exact release; each must fail closed without a HOME Core cache fallback.
9. Upgrade only the Claude thin adapter to `adapterVersion` 1.0.2 while keeping
   Codex at 1.0.1 and loader protocol v1 compatible.
   Confirm SessionStart returns one exact sync action within five seconds and
   does not install. The agent syncs in the normal turn while the old adapter
   continues the current task. The new Claude adapter is guaranteed next
   session. Repair Claude twice and confirm the cache version and payload digest
   remain identical for 1.0.2. Inject one provider-install failure, verify
   rollback and quiet `update_deferred`, and confirm current First Tree work
   continues.
10. If bounded safe recovery still fails, confirm the agent reports only the
   blocker, attempted recovery, and one concrete next step; raw diagnostics are
   attached only when needed for targeted troubleshooting or a bug report.

## Observe

- Persistent handoff schema is 3 and contains stable descriptions plus loader
  commands, not reusable Plugin-cache Core paths. Loader response schema is 1,
  `consumerKind` is `byo`, and paths remain inside one verified exact CLI
  release root with matching Skill and Policy digests.
- Provider Plugins contain only discovery stubs, SessionStart adapter, and
  loader calls. They contain no full Read/Write workflow or Policy copy.
- Legacy full→thin migration and repair wait for the next Claude SessionStart
  before automatic persistent routing. Core-only upgrades and new
  Team grants leave adapter bytes/version/digest and install plan unchanged.
- A routine compatible adapter update is not setup failure: current tasks keep
  their verified loaded adapter, sync runs outside SessionStart, and provider
  action is requested only for a provider-reported Hook identity change.
- Session-only loads verified Core without installing Plugin, Hook, grant, or
  lifecycle state and does not promise future-session activation.
- The current conversation adopts `activationContext`, loader catalog, scope,
  and immutable provider/project receipt. It never reclassifies from changed
  cwd. Every task still runs the loader; reuse requires the exact Skill or
  Policy digest plus full content that remains directly available in the
  current provider context. It never relies on a path or summary, independently
  hashes Core files, or persists a Core cache.
- Human confirmation boundaries remain unchanged under recovery. No recovery
  path chooses scope, changes account, authenticates, grants permission, trusts
  a provider, resets state, or accepts a changed plan.

## Expected Result

`PASS`: Codex returns a usable current-session handoff in the original
conversation; first Claude migration returns no current-session handoff and
uses next-session adoption for automatic routing; later Core-only releases load on the next task with stable adapter
identity; unchanged Core content is reused only by
digest while changed or unavailable content is reread; adapter 1.0.2 is adopted
through the compatible update path; recovery is bounded, concise, and preserves
every human boundary; all tamper and legacy paths fail closed.

`FAIL`: a legacy workflow reads Tree data, Claude automatic routing resumes
before a valid next SessionStart, same-version repair changes the cache payload,
a Core-only release repairs or retrusts the Plugin, loader escapes or uses
a mutable path/HOME cache, a task skips the loader, Core reuse relies on a path,
name, release, or summary, setup leaks internal envelopes by default, or safe
recovery crosses a human boundary.

`BLOCKED`: disposable real providers, staging identity/Team, exact-version
release fixtures, or controlled failure injection cannot be prepared.

`INCONCLUSIVE`: only unit tests/mocks were observed, provider conversations are
not the same ones used for setup, or adapter/Core byte evidence is missing.

## Evidence

Keep redacted Web prompt and concise transcript, exact apply commands, typed
failure/recovery evidence, before/after adapter manifests and byte digests,
Claude next-session adoption, Codex trust rows, loader envelopes and exact release
paths, Tree read receipts, and tamper/legacy failure output. Record versions,
timestamps, task/session ids, and fixture restoration.
