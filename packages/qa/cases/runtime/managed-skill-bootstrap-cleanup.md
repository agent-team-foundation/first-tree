---
id: runtime-managed-skill-bootstrap-cleanup
description: Validate that packed Client session bootstrap safely reconciles an untrusted managed-skill ledger without deleting outside exact stale skill leaves.
areas: [runtime]
surfaces: [cli, client, server]
---

# Managed Skill Bootstrap Cleanup

## Goal

Confirm that a packed First Tree CLI, including its bundled Client and skill payloads, can start a real tree-bound agent
session from a workspace whose `.first-tree-workspace/managed.json` is hostile. Bootstrap must remove legitimate retired
managed skills from `.agents/skills` and `.claude/skills`, roll the ledger forward, and leave every root, external target,
current shipped skill, and unledgered user skill intact.

This is a local filesystem cleanup and data-integrity case, not a network-security or authentication-hardening case. It
validates lexical containment of ledger-controlled names while the workspace and both skill-root topologies are trusted
and stable. A pre-existing or raced symlink, junction, or mount at `.agents`, `.claude`, either `skills` root, or an
ancestor is outside this case; do not create one as a fixture. The final skill leaf may itself be a symlink and is in
scope.

## Preconditions

- Complete the repository-wide `QA READY` gate first. Use a resolved, isolated Docker run root, a run-local bare clone
  and detached worktree at the exact target ref, a unique Docker project, isolated homes/volumes/networks, and an
  evidence directory outside the tested repository.
- Build and pack the release-candidate CLI from the target worktree, hash the tarball, and install it into a clean
  run-local consumer prefix/home. Verify that the installed package contains the bundled Client runtime and skill
  payloads. A source-module import, direct installer/helper call, mock, or Vitest result cannot satisfy this case.
- Use a disposable Server/Client deployment, user, Team, tree-bound agent, Chat, and Context Tree binding. The selected
  provider must be one-turn-ready so an actual start and resume can cross the installed CLI/Client session-bootstrap
  boundary. Keep all credentials and provider state run-local.
- Establish the workspace once through the product, stop the agent session and Client cleanly, then prepare the
  filesystem fixtures while no process can mutate the workspace. Preserve the normal directory topology for the
  workspace, `.agents/skills`, and `.claude/skills`.
- Force the next packed-runtime start down the integration bootstrap path using a recorded, realistic upgrade state,
  such as an older cached bundled-CLI version or a missing integration pin in an otherwise initialized tree-bound
  workspace. Do not invoke reconciliation directly.
- Discover and record at least one currently shipped skill name and the target artifact's expected managed ledger set.
  Do not assume that every default/core skill appears in the tree-integration ledger.
- Keep every malicious target and sentinel below the resolved run root. Never aim a fixture at `/`, a drive root, a real
  UNC share, the operator's home, or any non-run-owned path.

## Harness Capabilities

- **Build:** build and pack the final CLI/Client artifact, record toolchain and artifact identities, install from the
  tarball, and verify the source worktree remains free of unexpected changes.
- **Run:** start the complete isolated First Tree harness required by readiness, including the Server/database and the
  installed Client daemon/runtime path used by the selected provider.
- **Drive:** use a real product action, such as a Chat delivery through the disposable deployment, to start and then
  resume the tree-bound agent. Do not substitute an internal function call for either bootstrap.
- **Observe:** combine redacted Client/session logs with independent `lstat`/`readlink`, content hashes, directory
  manifests, and parsed-ledger readback after the runtime has quiesced. Logs alone are insufficient.
- **Measure:** retain build/pack/install duration and size, Client start-to-ready time, cold reconciliation/bootstrap
  duration, warm resume duration, and a lightweight CPU/memory/disk sample. One sample demonstrates measurement
  capability; it is not a regression claim without a declared baseline and repeated protocol.
- **Reset:** define a stopped-runtime restore from a run-local golden workspace snapshot, prove one reset before task
  execution, and tear down the unique Docker project, volumes, homes, worktree, and credentials after evidence capture.

## Workspace Fixture

Create marker contents with unique, non-secret values and capture a typed, hashed pre-bootstrap manifest. At minimum,
prepare these run-owned paths:

| Fixture | Required setup and expected boundary |
| --- | --- |
| External sentinel | A file and directory outside the agent workspace but below the run root; their types and content hashes should not change. |
| Workspace sentinel | A marker at the workspace root; the workspace and its runtime/identity files must remain present. |
| Root sentinels | Distinct markers directly inside both `.agents/skills` and `.claude/skills`; both roots and markers must survive. |
| Sibling-prefix sentinels | Marked siblings such as `.agents/skills-shadow` and `.claude/skills-shadow`; names that merely share the root prefix must not be touched. |
| Protected current skill | One skill shipped by the packed target, present in the hostile ledger and installed in its normal `.agents` plus Claude companion shape; it must remain usable and match the packed payload. |
| Unledgered custom skill | A user-created `custom-local` payload and companion entry absent from the ledger; preserve its type, link text, and content hashes exactly. |
| Canonical stale skill | A valid lowercase-kebab retired name such as `retired-safe`, with a real `.agents/skills` payload and normal Claude companion; both stale entries should disappear. |
| Stale leaf links | A valid retired name such as `retired-leaf-link`, represented by leaf symlinks under both roots that point to external run-owned sentinels; unlink the leaves without changing either target. |
| Nested stale link | A real stale directory such as `.agents/skills/retired-nested-link` containing ordinary files and a nested symlink to an external sentinel, plus its Claude companion; remove the stale directory/link without following the nested target. |

Write the ledger as raw JSON rather than through a product writer. Mix the protected current skill, all valid stale names,
and duplicate valid entries with hostile values covering each of these classes:

- empty and whitespace-only strings;
- `.` and `..`, multi-level traversal, nested segments, and forward- or backslash-separated names aimed only at the
  run-owned workspace, sibling, and external sentinels;
- POSIX absolute syntax; Windows drive-relative (`C:` and `C:foo`), drive-absolute, root-relative, UNC, and device-
  namespace spellings, without contacting a real share;
- escaped control characters such as newline, tab, and NUL;
- non-ASCII, uppercase/mixed-case, and a value longer than 64 characters;
- non-string array members, to ensure untrusted JSON shape does not acquire path meaning.

Retain the exact pre-bootstrap raw ledger as evidence. If a host-specific absolute spelling is used, resolve it only to a
sentinel owned by this run.

## Exercise And Observe

Start a new session through the installed product and wait for both the bootstrap and the minimal provider turn to reach
a terminal state. Stop or quiesce the Client before filesystem readback. The primary run should show all of the
following:

- the agent session starts from a tree-bound runtime configuration and the packed artifact, rather than a source helper;
- every canonical stale entry is absent from both skill roots;
- stale leaf symlinks themselves are gone, while their external targets are byte-for-byte unchanged;
- the real stale directory and its nested symlink are gone, while the nested external target is unchanged;
- the workspace, both skill roots, root markers, sibling-prefix sentinels, workspace sentinel, and external sentinels
  retain their pre-bootstrap types and hashes;
- the protected current skill remains installed in the target artifact's expected shape and matches the packed payload;
- the unledgered custom skill and companion remain exactly as captured before bootstrap;
- `managed.json` is valid schema-version-1 JSON containing exactly the target artifact's current tree-integration ledger
  set, with the target CLI version/timestamp fields rolled forward as currently contracted. It contains no hostile,
  stale, duplicate, or custom entries and leaves no temporary sibling behind;
- a subsequent real resume/start with no fixture changes is idempotent: the session remains usable, the ledger stays
  normalized, and no protected filesystem object changes unexpectedly.

After restoring the golden fixture, use separate starts to cover malformed JSON and an unsupported future schema. In
both fail-safe branches, a valid stale leaf must remain because the prior ledger cannot authorize deletion; bootstrap
must still continue and replace the unreadable/unsupported record through the normal schema-version-1 ledger
roll-forward. Record the pre-delete state and post-bootstrap roll-forward independently for each branch.

If live behavior contradicts source-level expectations, preserve the run cell and investigate only far enough to
separate a target defect from fixture, permission, provider, or harness error. Do not patch the product or committed case
during the run.

## Expected Result

`PASS`: the complete harness reached `QA READY`; the installed, hashed package drove real tree-bound session start and
resume; only valid stale immediate-child entries were removed; symlink targets and all sentinels/current/custom content
survived; malformed/future ledgers authorized no stale deletion; and each run produced the expected safe ledger
roll-forward with credible independent readback.

`FAIL`: with valid run-owned fixtures and a ready harness, the target reproducibly deletes or mutates a root, parent,
sibling-prefix path, external target, current skill, or unledgered custom skill; follows a stale leaf/nested symlink;
fails to remove an authorized stale immediate child from either root; lets an invalid ledger name drive deletion; treats
malformed/future state as deletion authority; writes an unsafe/incorrect next ledger; or prevents the otherwise valid
session bootstrap. Produce a bug artifact without implementing a fix.

`BLOCKED`: Docker/worktree isolation, packed-artifact build or installation, symlink-capable run-owned storage, the
disposable tree binding, a one-turn-ready provider, or the real Client session path cannot be established. Unit tests or
direct helper calls may aid diagnosis but do not convert this status to `PASS`.

`INCONCLUSIVE`: bootstrap ran but artifact identity, trigger state, pre/post manifests, session completion, or
independent filesystem readback is missing, partial, unstable, interrupted, contradictory, or cannot be attributed to
the target ref.

## Evidence And Redaction

Keep evidence outside the source repository: exact commit/ref; package filename, hash, installed version, bundled Client
and skill identities; run-context capability matrix; sanitized build/install/start commands and exit statuses; tree
binding and bootstrap-trigger facts; redacted session/Client logs; raw pre-ledgers and parsed post-ledgers; and pre/post
typed filesystem manifests with relative paths, hashes, modes, symlink text, and sentinel results. Include cold/warm
timings, lightweight resource/disk observations, reset proof, cleanup state, and a final case disposition.

Redact access and refresh tokens, cookies, authorization headers, database/provider connection strings, private keys,
provider homes, private repository URLs, personal data, private Chat content, and sensitive absolute host paths. Preserve
only pseudonymous IDs and sanitized path suffixes needed to correlate the session, workspace, and evidence. Retain any
unredacted material only at a safe local artifact path and never attach it to a shared report.
