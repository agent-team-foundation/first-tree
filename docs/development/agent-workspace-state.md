# Agent Workspace State Files

This page documents the CLI-owned state files that live inside an agent's
home directory and the contract they enforce. If you're touching anything
under `<workspace>/.first-tree-workspace/`, anything that calls `prepareSourceRepos`,
`installFirstTreeSkills`, or `ensureAgentBootstrap`, or you're proposing a
new directory-structure migration — start here.

## Why these files exist

Agent workspaces are long-running. The CLI clones source repos, installs
skill payloads, and writes a briefing into each one on every session
start. Over time, the CLI's CONFIG of what it materialises drifts:

- A source repo is removed from the agent's predeclared `gitRepos` list.
- A skill is dropped from the bundled `TREE_SKILL_NAMES`.
- The layout itself changes between major releases (the per-chat-cwd ->
  per-agent-home transition, the W1 workspace-rooted simplification, the
  retired `first-tree-hub/` source repo, etc.).

Without a record of what the CLI previously installed, removed resources
sit on disk forever. The state files below are that record.

## The files

| Path (relative to workspace root) | Owner | What it is |
| --- | --- | --- |
| `.first-tree-workspace/managed.json` | `runtime/managed-state.ts` | Schema-versioned record of the CLI-managed resources currently materialised in this workspace. Two arrays: `sourceRepos` (localPath names) and `skills` (skill names). Diffed on every session start to discover removals. |
| `.first-tree-workspace/migrations-applied.json` | `runtime/workspace-migrations.ts` | Set of one-shot directory-structure migration ids that have already run in this workspace. Each migration runs at most once even if it's later removed from the registry; the marker stays as forward protection. |

Both files use atomic writes (temp + rename) so a crashed writer never
leaves a half-formed JSON record on disk.

### `.first-tree-workspace/managed.json` schema

```json
{
  "schemaVersion": 1,
  "cliVersion": "0.3.2",
  "updatedAt": "2026-06-08T15:50:00.000Z",
  "sourceRepos": ["first-tree", "first-tree-context"],
  "skills": ["first-tree", "first-tree-context", "first-tree-sync"]
}
```

- **`sourceRepos`** — the `localPath` of each repo from `payload.gitRepos`
  the CLI cloned at workspace top level.
- **`skills`** — the names of skills installed under
  `<workspace>/.agents/skills/<name>/` (with matching `.claude/skills/<name>`
  symlinks).
- **`schemaVersion`** — increment when the shape changes; readers reject
  unknown versions and treat them as "no prior state".

When the file is missing or malformed, the reconcile path treats it as
"first run on this workspace" and performs no deletions — the safe
default.

### `.first-tree-workspace/migrations-applied.json` schema

```json
{ "schemaVersion": 1, "applied": ["v1-uuid-snapshots", "v1-whitepaper-symlink"] }
```

A migration whose `apply` raises is NOT recorded, so a future session
retries it. The marker file is rewritten only when at least one migration
newly applied this run.

## Reconcile flow on session start

`ensureAgentBootstrap` (in `runtime/agent-bootstrap.ts`) runs migrations
before any other bootstrap step:

1. **`applyPendingMigrations`** — walk `MIGRATIONS_REGISTRY`, run each id
   not already in the marker. Failures don't block siblings; ids are
   persisted only after a clean run.
2. The existing first-run-vs-steady-state sentinel logic continues.

### Two outcomes that block the marker

A migration's `apply` can finish in three ways:

- **clean return** (`undefined`) — migration ran; marker recorded; id
  never re-runs.
- **`"deferred"` return** — migration could not safely run this session
  (typically because the live source-repo config is unresolved); marker
  NOT recorded; the next session retries from scratch.
- **`throw`** — unexpected I/O / git failure; marker NOT recorded;
  logged via the `failed` channel; the next session retries.

The `deferred` outcome is specifically for migrations whose correctness
depends on the live agent config (`MigrationContext.currentSourceRepoNames`).
Those migrations call `hasResolvedConfig(ctx)` at the top and defer when
the caller could not resolve a payload. Persisted `managed.json` is NOT a
safe fallback — it proves a previous config, not the current one — so any
deletion that relies on "what's missing from the current config" must
wait for a session with a real payload.

Migrations whose check is purely local (e.g. `v1-whitepaper-symlink`'s
"is this entry a symlink?") ignore the context and proceed unconditionally.

State-based source/skill cleanup runs from inside the installers that
already operate per session:

- **`prepareSourceRepos`** (`runtime/source-repos.ts`) — after the per-repo
  clone/fetch loop, diff `prev.sourceRepos` against the current set and
  remove any clone no longer in the config. Safety guards apply (see
  below); state is then rewritten to the current set.
- **`installFirstTreeSkills`** (`runtime/first-tree-skills/installer.ts`)
  — same diff against `TREE_SKILL_NAMES`. Dropped skills lose their
  `.agents/skills/<name>/` payload AND their `.claude/skills/<name>`
  symlink.

Both call sites share the `updateManagedState` helper, which read-modify-
writes atomically so a write to one field cannot clobber the other.

## Safety guards for clone deletion

Every clone deletion — both state-based and migration-driven — goes through
`tryRemoveCloneSafely` in `runtime/source-repo-cleanup.ts`. The guards are:

1. **Dir missing** → `absent`, noop.
2. **No `.git/`** → `not-a-clone`, noop. (Not ours to delete.)
3. **`git status --porcelain` reports anything** → `dirty`, skip.
4. **HEAD ahead of upstream** → `ahead-of-upstream`, skip. An empty repo
   with no HEAD at all is treated as 0 commits ahead (nothing to lose).
5. **Dependent `git worktree` checkouts** → `has-worktrees`, skip.
6. **Any probe crashed / timed out** → `probe-failed`, skip. Conservative
   default: we'd rather leave a stale clone than nuke unpushed work.

A skipped clone stays on disk and becomes an operator follow-up. The
state file is still updated to the current set so the next session
doesn't try the same skipped clone again as part of state-based cleanup
— the migration path is "best effort, one shot".

## What is NOT touched by this machinery

- **`<workspace>/.first-tree/`** — active W1 workspace binding state
  (`workspace.json`). The CLI never deletes this directory. A previously
  proposed `v1-legacy-dot-first-tree` migration was withdrawn during
  Codex review of PR #869 for exactly this reason.
- **`<workspace>/worktrees/`** — agent-self-managed. The agent creates
  per-task worktrees here and is responsible for cleaning them up. The
  CLI never sweeps this directory.
- **`<workspace>/notes/`** — agent's local implementation notes. CLI
  never touches it.
- **User-created files at workspace root** — third-party clones, custom
  skill payloads under `.agents/skills/`, regular `WHITEPAPER.md` files,
  anything else not in the recorded managed set. State-based cleanup is
  path-precise; migrations match on origin URL pattern (not directory
  name) for FT clones and on `lstat().isSymbolicLink()` for the
  WHITEPAPER.md sweep.

## Adding a new migration

When a future layout change introduces stale residue that warrants a
sweep:

1. Add a new entry to `MIGRATIONS_REGISTRY` at the END of the array
   with a fresh `vN-<short-name>` id. Old ids stay even when their
   bodies are simplified, so workspaces that have already applied them
   don't re-run.
2. The `apply` function MUST be idempotent (re-running on an already-
   clean workspace is a noop) and SHOULD short-circuit when there's
   nothing to do.
3. If the migration deletes clones, use `tryRemoveCloneSafely` so the
   dirty / ahead-of-upstream / worktree guards apply uniformly.
4. If the migration deletes symlinks, use `lstat().isSymbolicLink()` to
   confirm the entry type before unlinking — never delete a user-authored
   regular file.
5. Add unit tests covering the happy path AND the safety guards (a
   pristine workspace, an already-applied workspace, and at least one
   "blocked by safety" scenario).
6. The marker is per-id, never per-workspace — bumping the id of an
   existing migration would re-run it on every workspace.

## See also

- `runtime/managed-state.ts` — state-file I/O and read-modify-write helper
- `runtime/workspace-migrations.ts` — migration registry and applier
- `runtime/source-repo-cleanup.ts` — `tryRemoveCloneSafely` + probe helpers
- `runtime/source-repos.ts` — state-based source-repo reconcile
- `runtime/first-tree-skills/installer.ts` — state-based skill reconcile
- `runtime/agent-bootstrap.ts` — wires migrations into session start
- `packages/shared/src/schemas/workspace-manifest.ts` — the W1 binding
  manifest at `<workspace>/.first-tree/workspace.json` (distinct from
  `.first-tree-workspace/`; never touched by this machinery)
