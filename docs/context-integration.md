# External Context Integration

First Tree Context integration lets a person's existing Claude Code or Codex
session read and propose source-backed updates to one explicit Team's Context
Tree. It does not turn that provider session into a First Tree Agent or connect
its conversation to First Tree Chat.

## Support matrix

| Surface | macOS arm64/x64 | glibc Linux arm64/x64 | Windows | Remote/cloud session |
| --- | --- | --- | --- | --- |
| Claude Code CLI | P0 | P0 | First Tree distribution gap | Not in P0 |
| Claude Desktop local | P0 | Provider unavailable | First Tree distribution gap | Not in P0 |
| Codex CLI | P0 | P0 | First Tree distribution gap | Not in P0 |
| ChatGPT Desktop Codex local | P0 | Provider unavailable | First Tree distribution gap | Not in P0 |

Windows is not excluded because of Claude or Codex. First Tree does not yet
ship the required Windows portable binary, installer, path handling, and
native/WSL qualification. Remote provider environments also need a separate
credential and repository-authority design.

Minimum provider versions are recorded in the Context integration release
manifest embedded in every npm and portable distribution. The portable
manifest also records both adapter digests and the canonical Policy digest.

## Runtime contract

- Web Setup or an invitation continuation authors the exact Team handoff.
- `context enable` must run from the target code checkout.
- User-scope Plugin installation does not enable other repositories.
- Live activation calls
  `POST /api/v1/orgs/:orgId/context-activation/validate`; the URL carries the
  handoff-selected Team and the strict body carries only `schemaVersion` plus
  the canonical repository key. The Server resolves current membership from
  the path org before validating repository and Tree scope.
- SessionStart handles startup, resume, clear, and compact, but only activates
  an exact local binding that still passes live membership, Team repository,
  and Tree binding checks.
- External Read and Write never accept a Team argument. Their provider-specific
  hidden routes derive Team from the current provider + checkout binding and
  repeat the same live activation before every Read, initial Write authoring,
  push, and PR/MR creation.
- Activation failure never blocks ordinary provider work and never falls back
  to another Team or cached authority.
- SessionStart uses one non-retrying two-second live-authority attempt covering
  access-token refresh and the validator request inside a five-second provider
  hook budget, so timeout or network failure can return a controlled
  unavailable envelope instead of being killed by the provider. Explicit
  status, Read, and Write activation use a five-second attempt covering the
  same two stages and retry the same exact Team + repository once only for
  timeout, network, or HTTP 5xx failures. Authentication, authorization,
  binding, scope, and typed disabled results never retry. Failures expose
  stable timeout, network, server, or rejection reason codes without returning
  cached authority.
- Read does not depend on Reviewer readiness. A new official Write fails before
  remote mutation when Automatic Review is absent, disabled, structurally
  incomplete, or offline.

## Codex Hook consent and verification

Codex owns Hook consent. First Tree installs the Plugin but never bypasses,
pre-approves, or silently enables the SessionStart Hook. After the first
`context enable --provider codex`:

1. open Codex in the enabled checkout;
2. run `/hooks`;
3. find **First Tree Context → SessionStart**, enable its checkbox, and choose
   **Trust**;
4. exit and start a new Codex session in that checkout;
5. run `first-tree context status --provider codex` and confirm **Hook trusted**
   and **Hook enabled** are `Yes`, and **Live activation** is `Connected`.

Both `context enable` and `context status` query Codex's provider-owned
`hooks/list` API after installation. They report trust and enablement
separately, including a Hook that changed after approval. A previously trusted
and enabled Hook therefore does not receive another review prompt.

Status output also keeps machine/user/provider and repository authority
separate: provider compatibility, Plugin installation, Plugin enablement,
Hook trust, Hook enablement, current checkout, exact binding, and live Team
activation each have their own row. Checkout failures preserve their actual
cause and repair action: signed out, outside a Git checkout, or missing/invalid
`origin`.

## Upgrade, rollback, and disable

`first-tree context repair --provider <provider>` validates the embedded
release, stages the provider marketplace, and preserves the current installed
Plugin before attempting replacement. The local install manifest changes only
after the provider reports the new Plugin installed and enabled. On failure,
First Tree reinstalls the preserved provider cache; if that rollback also
fails, it reports both failures and leaves `context repair` as the explicit
recovery path.

Provider CLIs retain a reference to the local marketplace used during
installation. First Tree therefore keeps that required source at
`$FIRST_TREE_HOME/state/context/providers/<provider>/marketplace`; the
provider continues to own its installed Plugin cache. Repair atomically
replaces or restores this source, and successful uninstall removes it. This is
machine state required by the provider lifecycle, not a second release cache
or a new top-level First Tree directory.

Enable and disable use one operation coordinator across provider Plugin state,
the First Tree install manifest, and `config/context.yaml`. Its recovery
journal records the prior bindings, prior manifest, and provider rollback
source until every side commits. Repair uses the same durable coordinator, so
an interrupted reinstall is recoverable rather than being represented only by
the inner installer journal. A binding write or provider mutation failure
restores all three; an incomplete rollback remains fail-closed for explicit
repair.

Context mutations and local Client account switching share one machine-state
lock. An operation journal records the exact active Computer identity, and
recovery refuses to restore bindings under a different logged-in account.
Likewise, login/account switching refuses to move `context.yaml` while a
Context install, enable, disable, repair, or recovery is active or incomplete.
An installed-but-disabled provider Plugin is rejected before any local
mutation because its prior enabled state cannot be restored portably through
the supported provider CLI.

`first-tree context disable --provider <provider>` removes only the current
checkout binding. Add `--all` to remove every binding for that provider; the
provider Plugin and marketplace are removed only when no bindings remain.
Login credentials and the First Tree Client daemon are preserved.

An older First Tree binary may reject a newer embedded Plugin manifest. Restore
the matching First Tree release first, then run `context repair`. Never edit
Claude/Codex provider caches or `$FIRST_TREE_HOME/state/context` by hand during
normal recovery.

`context status`, SessionStart, and the hidden Read/Write routes compare the
installed bundle, Policy, and adapter digests with the current CLI's embedded
release. They also verify the complete materialized Plugin source and the
provider-owned installed cache, including both Skills, both Policy projections,
the launcher, and the hook definition. Install commits its ready manifest only
after the provider's actual installed path matches that payload. The same gate
enforces the provider minimum version. Any manifest, source, or provider-cache
drift reports `repair` and prevents Context activation without blocking ordinary
provider work.

The canonical Context Tree Policy has one source file. Managed workspaces
receive its bytes in the generated briefing; External Claude and Codex bundles
receive the same Policy bytes under each projected Read/Write Skill. The
generated External Skills also share one canonical source template; their
reproducible provider projections may differ only in the fixed adapter routing
needed to resolve the exact `provider + checkout` binding. The External
projection adds the mandatory lazy-load reference, while Managed Skills
continue to rely on the always-present briefing and never depend on a
Plugin-only relative file.

## Release qualification

Before production rollout, exercise each P0 surface with a staging Team and a
real repository:

1. ordinary startup with no binding;
2. enable, startup, resume, clear, and compact;
3. exact-snapshot Read and source-backed Write;
4. membership and repository-scope revocation;
5. server offline and provider hook rejection;
6. Reviewer missing, disabled, structurally incomplete, and offline;
7. Plugin upgrade, forced install failure/rollback, repair, and disable;
8. byte parity of managed briefing, Claude Plugin, and Codex Plugin Policy;
9. GitHub PR and GitLab MR review/repair/merge through the Managed Reviewer.

Production release remains blocked until these real-surface checks pass for
all supported architectures. Unit tests and package validation do not replace
that qualification.
