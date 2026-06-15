# Audit Workflow

Sync's first phase: walk the tree and the code, produce a `drifts[]` list.
The current CLI does not have a single `tree audit` command yet; this
workflow uses `tree verify` plus manual reading.

CLI examples in this workflow use the canonical prod binary `first-tree` for
readability. Substitute the channel-correct binary from AGENTS / current
channel (`first-tree` on prod, `first-tree-staging` on staging,
`first-tree-dev` on dev) before running them.

## Inputs

- one tree repo at `<workspaceRoot>/<tree>`, resolved by reading
  `<workspaceRoot>/.first-tree/workspace.json` directly (schema:
  `{ tree: "<dir>", sources: [...] }`). The `<binName> tree status`
  CLI was retired in 2026-06 — the manifest is small JSON, `cat` it.
- one or more source repos at `<workspaceRoot>/<name>` for each
  `name` in `sources`. Under the agent-managed repo model these are
  **bare** clones (no working tree) — Phase 4 reads them through a
  read worktree, never the bare path directly (see Phase 4).
  Phase 4 iterates over **every** bound source; for multi-source
  trees this fans out serially per repo.
- optional `--since <ref>` to scope Phases 2–3 to changes since a commit
  (Phase 4 always sweeps current state, not a range)

## Phases

### Phase 1: Cheap Structural Pass

Run:

```bash
first-tree tree verify
```

`verify` exits non-zero on:

- missing `title`/`owners` frontmatter on a tree node
- broken `soft_links` targets (this surfaces `cross-domain-broken` directly)
- missing or malformed tree identity metadata
- members/ structure violations

Convert each verify failure into a candidate drift:

| `verify` failure                   | Drift type                               |
| ---------------------------------- | ---------------------------------------- |
| broken `soft_links` target         | `cross-domain-broken`                    |
| missing frontmatter on a leaf node | `tree-wrong` (the node is malformed)     |
| member validation failure          | `ownership-stale` candidate (re-confirm) |

Other verify failures are _structural_, not drift — fix them as
`tree-wrong` only if a human review confirms the node never made sense.

### Code-side phases read through worktrees

Phases 2, 3, and 4 all read source code. Each bound source is a **bare**
clone (no working tree) under the agent-managed repo model, so before any
code-side read, materialize one read worktree per source off its latest
default branch — following the **Worktrees** protocol in your `AGENTS.md`
/ `CLAUDE.md` briefing — and remove it when the audit is done:

```bash
# for each <source> in manifest.sources — the bare clone is at
# <workspaceRoot>/<manifest.sourcesRoot>/<source>, i.e. <workspaceRoot>/source-repos/<source>
# (a legacy flat manifest omits sourcesRoot → <workspaceRoot>/<source>):
git -C <workspaceRoot>/source-repos/<source> fetch origin
git -C <workspaceRoot>/source-repos/<source> worktree add <workspaceRoot>/worktrees/sync-<source> origin/main
# ... all Phase 2–4 reads below use this worktree as <source-root> ...
git -C <workspaceRoot>/source-repos/<source> worktree remove <workspaceRoot>/worktrees/sync-<source>
```

Throughout Phases 2–4, `<source-root>` / `<source-path>` resolve **inside
the read worktree**, never the bare clone path.

### Phase 2: Code-Vs-Tree Read-Through

For each `NODE.md` in the tree:

1. Identify the source-repo path the node describes (use the domain
   directory name as a hint; cross-check against the binding entries).
2. Read the matching code-side directory **in that source's read
   worktree** (see *Code-side phases read through worktrees*).
3. For each fact stated in the node, check whether code still supports it.
4. Classify any disagreement using `references/drift-taxonomy.md`.

This phase is read-only and human-paced. Do not write tree updates here.

### Phase 3: Recent-Change Sweep

If `--since <ref>` is set or the user wants a focused audit, run inside
the source's read worktree:

```bash
git -C <source-root> log --oneline <ref>..HEAD -- <source-path>
```

For each commit in the range:

- skim the diff
- ask: "did this commit move, rename, or remove anything the tree
  references?"
- if yes, classify as `tree-stale` or `code-not-synced` and add to
  `drifts[]`

### Phase 4: Code-Driven Sweep

The reverse of Phase 2: walk source structure and ask "does the tree
register this?". This is where `code-not-synced` drift is discovered on
its own (not just as a side-effect of reading the tree).

For each source repo in `sources` (from `<workspaceRoot>/.first-tree/workspace.json`),
with `<source-root>` = its read worktree (see *Code-side phases read
through worktrees*):

1. **Top-level directories**

   ```bash
   ls -1 <source-root> | grep -v '^\.'
   ```

   For each top-level dir not mentioned in the tree's `NODE.md` domain
   list, emit `code-not-synced/structural`. Skip dirs that are clearly
   build artifacts (`node_modules`, `dist`, `target`, `.next`).

2. **Submodules**

   ```bash
   git config -f <source-root>/.gitmodules --get-regexp 'submodule\..*\.path'
   ```

   For each submodule path whose subdir name is not in
   `manifest.sources` (and is not an obvious vendored / build dir),
   emit `code-not-synced/structural`. The fix is to add the submodule's
   subdir name to `workspace.json.sources` (one-line JSON edit); sync
   does not auto-bind the submodule itself.

3. **Active contributors**

   ```bash
   git -C <source-root> log --since='6 months ago' --format='%aN <%aE>' \
     | sort -u
   ```

   For each contributor without a `members/<slug>/NODE.md` file, emit
   `code-not-synced/structural` (add member stub with frontmatter only,
   no body). For changes to an **existing** member's owners list, use
   `ownership-stale` instead.

4. **Decision-relevant dependencies**

   Read whichever manifest files exist:

   ```
   <source-root>/package.json        → check dependencies + devDependencies
   <source-root>/pyproject.toml      → [project.dependencies]
   <source-root>/go.mod              → require ( ... )
   <source-root>/Cargo.toml          → [dependencies]
   ```

   For each decision-relevant dep (framework, runtime, datastore, agent
   SDK, build tool — not every transitive utility) absent from
   `.first-tree/org.yaml`'s `techStackConstraints`, emit
   `code-not-synced/structural`.

5. **`AGENTS.md` / `CLAUDE.md` sections**

   Split the file by `## ` and `### ` headings. For each section without
   a corresponding tree node, routing entry, or `soft_links` reference,
   emit `code-not-synced/substantive`. Record the heading and the
   line-range in `sourcePointer` so `first-tree-context` knows what to
   read.

6. **Decision docs**

   ```bash
   find <source-root>/{docs/rfcs,docs/decisions,adr,decisions} \
     -name '*.md' -type f -mtime -180 2>/dev/null
   ```

   For each doc not referenced from any tree node (grep the tree for
   the file path), emit `code-not-synced/substantive`.

#### Sweep budget

Phase 4 can produce many findings on a freshly onboarded tree. Default
budget: **20 findings**. If the sweep exceeds the budget, truncate and
print:

```
N more findings of type X (rerun with --scope X to see them all)
```

Optional scope flag (currently agent-side; no CLI flag yet):

```
--scope structural   # only steps 1, 2, 4
--scope substantive  # only steps 5, 6
--scope ownership    # only step 3
--scope all          # default
```

Phase 4 is **structural-aware, not content-aware**: it asks "is this
thing registered?" not "what does it say?". Reading code to extract
decision prose is `first-tree-context`'s job, not sync's.

## Output Shape

The audit phase emits a single `drifts[]` list. Each entry:

```json
{
  "type": "tree-stale | tree-wrong | tree-outdated | code-not-synced | cross-domain-broken | ownership-stale",
  "subtype": "structural | substantive | null",
  "treeNode": "<relative path inside the tree repo, or null when the finding is that no node exists yet>",
  "sourcePointer": "<repo>:<path>:<line?>",
  "summary": "<one sentence>",
  "evidence": "<commit sha, file path, or quoted line>",
  "decisionLocksCode": false
}
```

`subtype` is required for `code-not-synced` (`structural` or
`substantive`) and `null` for the other five types. `treeNode` is `null`
for Phase 4 findings where the tree node does not yet exist.

Print as JSON for downstream tooling; also print a short human-readable
table for the user.

## Boundaries

- Do not audit a tree that is not bound to the current source/workspace.
  Sync requires reading code from the right repos — if the workspace is
  unbound, surface to a human (binding a workspace is an operator action
  taken from the web console, not an in-agent flow).
- Do not produce any fix in the audit phase. Fixes go to the fix workflow
  (`references/fix-workflow.md`), where ownership and human-review rules
  apply.
- Do not draft decision prose during audit. Phase 4 records the source
  pointer for substantive gaps and stops; the prose itself is
  `first-tree-context`'s job.
- Do not auto-bind unbound submodules discovered in Phase 4 step 2. Emit
  a `code-not-synced/structural` finding and surface it to a human —
  binding a source repo to a tree is an operator action taken from the
  web console, not from inside an agent.

## Exit Conditions

- All drift candidates are classified and written into `drifts[]`.
- Findings that need human disambiguation are flagged with the question
  attached, not invented as drift.
- If the audit produces zero drifts, return that explicitly. "No drift" is
  a valid result; treat silence as a bug.
