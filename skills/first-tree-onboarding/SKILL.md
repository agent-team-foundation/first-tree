---
name: first-tree-onboarding
version: 0.6.0
cliCompat:
  first-tree: ">=0.5.0 <0.6.0"
description: One-shot onboarding command for First Tree. Drives a repo or workspace from "no first-tree" all the way to "workspace.json bound, real content drafted, daemon running, agent templates confirmed" — end to end, in one skill invocation. Trigger this skill when the user invokes `/first-tree-onboarding`, says "onboard this repo to first-tree", "set up first-tree here", "complete first-tree onboarding", "migrate this workspace to W1", or runs first-tree against an unbound repo or workspace. Also trigger when re-running on an already-bound repo to refresh skills, draft missing content, or reverify the daemon. Use this skill instead of running `first-tree tree init` from raw memory; it owns role-by-role branching, the initial-content drafting phase the CLI does NOT do, the W1 migration of legacy multi-mode workspaces, and the final doctor checks.
---

# First Tree Onboarding (one-shot command)

When the user invokes this skill, you (the agent) drive onboarding **end to end**. Phases A→F below run in order. Within a phase, **execute without asking** unless the action is irreversible or genuinely ambiguous (see "When to ask the user"). At the end, print the wrap-up summary in Phase F.

Read first: [`../first-tree/SKILL.md`](../first-tree/SKILL.md) and [`../first-tree-context/SKILL.md`](../first-tree-context/SKILL.md). They define the workspace and tree concepts the rest of this skill assumes.

## Success criteria (do not claim done until ALL pass)

1. `first-tree tree status --json` reports a `workspaceRoot`, a `manifest.tree`, and a non-empty `boundSources[]` whose entries are present on disk (`present: true`).
2. The bound tree exists on disk at `<workspaceRoot>/<manifest.tree>`, and `first-tree tree verify --tree-path <workspaceRoot>/<manifest.tree>` exits 0.
3. The tree's `NODE.md`, `members/owner/NODE.md`, and `.first-tree/org.yaml` contain real content (no remaining placeholder strings — see [`references/content-drafting.md`](references/content-drafting.md) §Detection).
4. `first-tree tree skill doctor` exits 0 from the workspace root.
5. If the user opted in to the daemon: `first-tree github scan doctor` exits 0.
6. Tier 0's `validate.yml` exists inside the tree subdir, the agent has explained that Tier 1 lives in `first-tree cloud`, and either skipped Tier 2 or run `first-tree tree automation install --tier 2 --tree-path <workspaceRoot>/<manifest.tree>` and recorded the returned stage.
7. The user has explicitly confirmed which agent templates to keep in `<workspaceRoot>/<manifest.tree>/.first-tree/agent-templates/`.

If any of these fails, stop and report — never silently mark onboarding complete.

## When to ask the user (default = act)

Ask **only** before:

- Pushing a branch or PR to a remote (always show diff first).
- Choosing where the tree lives when both "create new tree" and "bind existing tree" make sense.
- Promoting a single-repo legacy layout into a workspace dir during migration (`migrate-to-w1` Case B/C). The move is destructive, so the CLI prompts; if you pre-decided a name, pass `--workspace-name <name>`.
- Creating a new GitHub repo for the tree (`gh repo create`) — visibility (public/private) must be confirmed.
- Deleting partial state to recover from a corrupt binding.

Everything else: read state, decide, execute, verify. Do not narrate every CLI call to the user — only report at phase boundaries.

## Phases

Each phase has **entry signal → action → exit gate**. If the exit gate fails, stop and surface the error; do not advance.

### Phase A — Pre-flight (always)

**Entry signal:** skill invoked.

**Action:**

1. `first-tree tree status --json` from cwd → record `workspaceRoot`, `manifest.tree`, `manifest.sources`, `boundSources[]`, `unboundGitSiblings[]`.
2. `first-tree --version` → record CLI version.
3. `gh auth status` → record success/failure (do not stop on failure yet).
4. Branch on the status output:

| Status output                                              | Next                                                                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Reports a workspace root + tree + bound sources (W1)       | Skip Phase B; jump to Phase B-refresh, then Phase C.                                                  |
| Exits non-zero with "No First Tree workspace found"        | Either Phase B (new workspace) OR Phase A.5 (legacy 0.5.x → W1 migration). See Phase A.5 entry signal. |
| Cwd is inside the tree subdir of a workspace               | **STOP.** Tell the user: "You're inside the tree subdir of a workspace. cd to the workspace root and re-run." (Detect by checking whether cwd resolves to or under `<workspaceRoot>/<manifest.tree>` after walking up from cwd to find the manifest.) |

**Exit gate:** workspace shape classified; `workspaceRoot` known when bound, or "needs binding" / "needs migration" flag set.

### Phase A.5 — Migrate legacy workspace (only when Phase A detected legacy state)

**Entry signal:** the user explicitly says they're migrating from a pre-0.6.0 layout, OR `tree status` exited 1 AND any of these legacy markers exist on disk: `.first-tree-workspace` marker file anywhere up the path, `<tree>/.first-tree/bindings/` directory, or `<source>/.first-tree/source.json`. `tree status` no longer surfaces a legacy role, so the signal is filesystem-based.

**Action:**

1. `first-tree tree migrate-to-w1 --dry-run` from cwd → review the plan (which legacy artifacts get removed; what `workspace.json.sources` will look like).
2. If the plan looks correct: `first-tree tree migrate-to-w1`. For single-repo Case B/C layouts the command prompts before the `mv` step; if the user already named a workspace dir, pass `--workspace-name <name>`. To skip the prompt in scripted runs use `--yes`.
3. Re-run `first-tree tree status --json` → confirm the new layout.
4. The migration leaves dirty working-tree edits in the tree and each source repo; tell the user to inspect and commit before continuing.

**Exit gate:** `first-tree tree status --json` reports `workspaceRoot` + `manifest.tree` + non-empty `manifest.sources`. The migration result is separate — its own JSON output reports `dryRun: false`, an empty `warnings[]` (or only acceptable warnings the user has acknowledged), and no `kind: "not-applicable"` from the prior dry-run. Use `tree status` for the post-migration shape check; use the migrate output for the cleanup audit trail. Do not conflate the two.

### Phase B — Bind (auto unless ambiguous)

**Entry signal:** Phase A reported "needs binding" (no workspace anywhere up the path).

**Action:**

1. Decide tree mode. Defaults below — only ask the user if marked ⚠.
   - **Lone source repo (no parent workspace dir yet)** → W1 requires source + tree as siblings under a workspace root, so the source has to live inside that root before `init` can write the manifest. Pre-create the workspace dir, move the source into it, then init from there:
     1. Pick a workspace dir name (default = `<source-name>-workspace`). Ask the user before moving if they have a preferred name.
     2. From the source repo's parent: `mkdir <workspace-name>` and `mv <source-repo> <workspace-name>/`. The source repo path changes — warn the user before the `mv`.
     3. `cd <workspace-name>`.
     4. `first-tree tree init --scope workspace --tree-path ./<tree-name> --tree-mode dedicated --workspace-id <slug>` (or `--tree-mode shared --tree-url <url>` for an existing remote tree).
   - **Workspace root with multiple child repos (cwd is already the workspace dir)** → `first-tree tree init --scope workspace --tree-mode shared --workspace-id <slug-of-source-root>`. Adds `--tree-url <url>` for an existing remote tree.
2. `first-tree tree init` runs all of: install the five shipped skills at the workspace root, write framework `AGENTS.md` / `CLAUDE.md` at the workspace root, scaffold the tree subdir (when no `--tree-url`) or clone it (when `--tree-url`), and write `<workspaceRoot>/.first-tree/workspace.json` with every immediate-child git repo at the workspace root listed under `manifest.sources`. Init does not recurse into nested git repos and does not install per-source skill/framework files.
3. After init succeeds, walk `unboundGitSiblings[]` from a fresh `first-tree tree status` and ask the user which to add to `sources`. Adding a source is an in-place edit to `workspace.json.sources`; no separate CLI command is needed.
4. `first-tree tree verify --tree-path <workspaceRoot>/<manifest.tree>`.

**Exit gate:** `tree verify` exits 0. `tree status --json` reports a workspace (`workspaceRoot` + `manifest.tree` + non-empty `boundSources[]`). If status still exits 1 after init succeeded, init most likely ran from the wrong cwd (inside the source rather than the pre-created workspace dir). Re-read SKILL.md Phase B and re-run from the correct workspace root.

### Phase B-refresh — Already bound (auto)

**Entry signal:** Phase A reported a W1 workspace.

**Action:**

1. `first-tree tree skill upgrade` from the workspace root (idempotent, picks up newer shipped skills).
2. Re-run `first-tree tree status` and surface any `unboundGitSiblings[]` or `missingBoundSources[]` to the user. Adding a sibling = append its name to `workspace.json.sources`. Cloning a missing source = standard `git clone <remoteUrl> <name>` next to the tree (read `<missingBoundSources[?].name>` for the subdir name; `boundSources[?].remoteUrl` for the URL when present).
3. `first-tree tree verify --tree-path <workspaceRoot>/<manifest.tree>`.

**Exit gate:** verify passes. Continue to Phase C.

### Phase C — Draft initial tree content (auto)

**Entry signal:** any of:

- `<workspaceRoot>/<manifest.tree>/NODE.md` body still contains the literal string `"The living source of truth for your organization"`, OR
- `<workspaceRoot>/<manifest.tree>/members/owner/NODE.md` still contains `"Default bootstrap member node"`, OR
- `<workspaceRoot>/<manifest.tree>/.first-tree/org.yaml` `companyContext.industry` is the empty string `""`.

If none match → skip Phase C. The combined check is reliable because all three placeholders come from the CLI's bootstrap templates — the moment a human or agent has drafted real content, at least one will have changed.

**Action:** follow [`references/content-drafting.md`](references/content-drafting.md) verbatim. Summary:

1. Set `TREE=<workspaceRoot>/<manifest.tree>` (read both from `tree status --json`).
2. `git -C $TREE checkout -b chore/initial-content-draft` (if not already on it).
3. Read source signals from each `<workspaceRoot>/<sourceName>`: `README.md`, top-level dir layout, `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` / etc., recent `git log --since='6 months ago' --format='%aN <%aE>'`, `gh repo view --json description,topics,homepageUrl` (if gh ok).
4. For each tree field listed in `content-drafting.md` §Extraction Rules, run the matching rule. Mark every field with `# unverified — source: <where>` if confidence is low. **Never invent facts not present in the source signals.**
5. `git -C $TREE diff --staged` and present to user. Get explicit "yes" before remote actions.
6. `git -C $TREE commit` → `git -C $TREE push -u origin chore/initial-content-draft` → `gh pr create --repo <slug> --title "..." --body "..."` (or, if user prefers, push to `main` directly — ask).
   **Exit gate:** all three placeholder strings from the entry signal are gone in the on-disk tree. If the user chose the PR flow and the PR is still open (not merged), treat Phase C as **deferred** — print the deferred summary in Phase F and exit; the user re-runs `/first-tree-onboarding` after merging to finish the remaining phases.

### Phase D — GitHub Scan daemon (auto if gh ok; otherwise stop here)

**Entry signal:** Phase C exit gate passed.

**Action:**

1. If gh auth failed in Phase A: stop. Tell user `gh auth login`, do not attempt install. Skip to Phase E only when the user explicitly says "skip the daemon".
2. Ask once: "Install the GitHub Scan daemon for `<owner/repo>`? It polls notifications and dispatches PR-driven tree updates. (yes/skip)". Default = yes.
3. Decide `--allow-repo`: start with each bound source repo's `<owner>/<repo>` from `boundSources[].remoteUrl`. Wider globs are a follow-up the user opts into later.
4. `first-tree github scan install --allow-repo <owner/repo>`.
5. `first-tree github scan doctor`.

**Exit gate:** `doctor` exits 0, OR user explicitly opted out (record this in the wrap-up summary).

### Phase D.5 — GitHub automation rule layer (always)

**Entry signal:** Phase D done or skipped.

**Action:**

1. Confirm `<workspaceRoot>/<manifest.tree>/.github/workflows/validate.yml` exists. If it does not, run `first-tree tree upgrade --tree-path <workspaceRoot>/<manifest.tree>` once and re-check.
2. Tell the user, explicitly:
   - Tier 0 (`validate.yml`) is installed by default and is rule-based.
   - Tier 1 (AI PR review) is **not** installed by this skill and belongs to `first-tree cloud`.
   - Tier 2 (`owners:` gate + auto-merge / review-enforcer) is optional and rule-based; if the user wants it now, the CLI will prepare workflow files and print the GitHub ruleset commands, but the agent must not execute those policy-changing `gh api` calls.
   - The exact current parity target with `first-tree-context`'s rule layer lives in [`references/github-automation.md`](references/github-automation.md). Use that file as the source of truth for what "proper tree GitHub automation" means.
3. Ask once: "Do you want to start Tier 2 now, or leave it for later?"
4. If the user says "start now", run:
   `first-tree tree automation install --tier 2 --tree-path <workspaceRoot>/<manifest.tree>`
   Then follow the returned stage:
   - `write_rule_layer`: workflow files were written or still need to land on the default branch. Show the tree diff. If the user wants a PR, follow the usual "show diff -> get explicit yes -> push / PR" rule. Do **not** run any printed `gh api` commands.
   - `create_ruleset` or `activate_ruleset`: print the command(s) and stop. The user runs them in their own terminal.
   - `configured`: record that Tier 2 is already active.
5. If the user says "later", record Tier 2 as skipped in the wrap-up summary and include the exact command to resume later.

**Exit gate:** `validate.yml` exists, and the wrap-up summary can truthfully state one of:

- Tier 2 skipped
- Tier 2 pending PR / ruleset work
- Tier 2 already configured

### Phase E — Agent templates (auto verify; ask only on add/drop)

**Entry signal:** Phase D.5 done.

**Action:**

1. List `<workspaceRoot>/<manifest.tree>/.first-tree/agent-templates/`. Confirm `developer.yaml` and `code-reviewer.yaml` exist (CLI wrote them in Phase B).
2. Ask: "Keep developer + code-reviewer? Add custom roles (designer / qa / etc.)?"
3. Apply changes per [`references/agent-templates.md`](references/agent-templates.md). For drops: `git rm`. For adds: copy `developer.yaml` as schema and edit the prompt + skills list.
4. Commit any changes to the tree.

**Exit gate:** user has confirmed the roster.

### Phase F — Wrap-up (always)

**Action:**

1. `first-tree tree skill doctor` from the workspace root → must exit 0.
2. `first-tree github scan doctor` if Phase D ran → must exit 0.
3. `first-tree tree status --json` → confirm a workspace root, tree, and at least one bound source.
4. Print the summary. Format:

   ```
   First Tree onboarding complete.

   Workspace:   <workspaceRoot>
   Tree:        <manifest.tree>  (<workspaceRoot>/<manifest.tree>)
   Sources:     <comma-separated sources from manifest>
   Tree URL:    <boundSources[?].remoteUrl or "not published">
   Daemon:      <running for <owner/repo> | skipped>
   GitHub Actions: validate.yml installed (Tier 0, rule-based)
   AI PR review:  not installed by this skill. Enable via your first-tree cloud deployment / onboarding flow.
   Owners gate:   <skipped | pending via `first-tree tree automation install --tier 2 --tree-path <treePath>` | configured>
   Agents:      <comma-separated template names>

   Next:
   - Edit <workspaceRoot>/<manifest.tree>/.first-tree/org.yaml to fill in stage/industry if marked unverified.
   - Open a PR in any source repo to see github scan dispatch the developer agent.
   - Run /first-tree-sync any time you suspect tree drift.
   ```

## Edge cases (inline rules)

| Situation                                                                          | Rule                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm install -g first-tree@latest` errors with `Unsupported URL Type "workspace:"` | Don't retry. Fall back to building from a local `agent-team-foundation/first-tree` checkout: `pnpm install && pnpm --filter first-tree build`, then run via `node <repo>/apps/cli/dist/index.js`.                                                       |
| `gh auth status` fails                                                             | Stop at Phase D entry. Don't install daemon. Don't push tree branches in Phase C — keep work local until `gh auth login`.                                                                                                                               |
| `tree init` rejects `--scope repo`                                                 | `--scope repo` is removed under W1. Follow Phase B's lone-source recipe: pre-create the workspace dir, `mv` the source in, `cd` in, then run `first-tree tree init --scope workspace --tree-path ./<tree> --tree-mode dedicated --workspace-id <slug>`. |
| `tree verify` fails after Phase B                                                  | Print the failures, stop. Most common cause: the sibling tree dir was created but `tree init` was interrupted mid-write. Recovery: `rm -rf <treePath>` then re-run `tree init`. **Always ask before rm.**                                                |
| `migrate-to-w1` reports `kind: "not-applicable"` with a clear reason               | Surface the reason and stop. Common causes: cwd is a workspace-member source whose parent is already a workspace (cd up), or `source.json` points at a non-sibling tree path (out-of-scope under W1's side-by-side assumption).                          |
| Phase C: source repo has no README and < 5 commits                                 | Generate the minimal scaffolding-replacement (real domain list from top-level dirs only) and mark every other field `# unverified — source repo too sparse to infer`. Open the PR anyway so the user can fill in.                                       |
| Phase C: tree was published to remote but local sibling dir is missing             | `tree status --json` exposes the tree separately from sources: read `treePresent` (and `treeRemoteUrl` when set). The tree is NEVER an entry in `boundSources[]` — that array is `manifest.sources` only. If `treePresent === false`, ask the user for the tree's remote URL (or use `treeRemoteUrl` if set) and `git clone <url> <workspaceRoot>/<manifest.tree>`. Re-run Phase C once `treePresent` flips to `true`. |
| Workspace root has many nested repos                                               | Default to NOT adding nested repos to `sources` automatically. List them to the user and ask which to bind.                                                                                                                                              |
| User re-runs the skill on already-bound repo                                       | Phase A → Phase B-refresh → Phase C (will skip if progress.md is fully checked) → Phase F. The skill is idempotent.                                                                                                                                     |
| Tree on a private GitHub org, gh user lacks repo-create scope                      | Skip `gh repo create` in Phase B. Commit locally and tell the user the manual `git remote add origin … && git push -u origin main` steps.                                                                                                               |
| Source repo and tree repo are on different GitHub accounts                         | Ask once which account the tree should live under. Default = same owner as source.                                                                                                                                                                      |
| Tier 2 command reports `create_ruleset` / `activate_ruleset`                       | Print the command from `first-tree tree automation install --tier 2 --tree-path <workspaceRoot>/<manifest.tree>`. Do not execute it yourself. Those repo-policy operations belong to the user.                                                          |

## Hard rules (never violate)

- **Never push to the tree's main branch without an explicit "yes"** from the user. Default for Phase C content is a PR.
- **Never start an agent runtime in Phase E.** Templates only. The daemon spawns agents.
- **Never claim onboarding done if any Phase F doctor exits non-zero.**
- **Never run onboarding inside the tree subdir.** `tree status` from there will detect it; stop and explain.
- **Never invent content in Phase C.** If a fact isn't in the source signals listed in `content-drafting.md`, leave the field empty with a `# unverified` marker.
- **Never bypass `gh auth status` failures** by hand-crafting tokens. Stop and instruct the user.
- **Never execute the Tier 2 ruleset `gh api` commands yourself.** Print them for the user and explain why they are manual.
- **Never run `migrate-to-w1 --yes` without first showing the dry-run output** — the promote step is destructive (`mv` source + tree into a new parent dir).

## References

- [`references/recipe.md`](references/recipe.md) — exact commands and verification per phase.
- [`references/content-drafting.md`](references/content-drafting.md) — Phase C extraction rules, confidence labels, tree-path resolution, PR flow.
- [`references/github-automation.md`](references/github-automation.md) — Phase D.5: Tier 0/Tier 1/Tier 2 split, Tier 2 stage meanings, and the manual-command boundary.
- [`references/role-decisions.md`](references/role-decisions.md) — workspace position × action matrix used by Phase A.
- [`references/agent-templates.md`](references/agent-templates.md) — Phase E template schema and add/drop rules.
- [`references/cli-quickref.md`](references/cli-quickref.md) — every CLI invocation this skill makes, in one place.
