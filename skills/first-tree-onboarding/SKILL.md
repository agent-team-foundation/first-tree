---
name: first-tree-onboarding
version: 0.4.0-alpha.2
cliCompat:
  first-tree: ">=0.4.0 <0.5.0"
description: One-shot onboarding command for First Tree. Drives a repo or workspace from "no first-tree" all the way to "tree bound, real content drafted, daemon running, agent templates confirmed" — end to end, in one skill invocation. Trigger this skill when the user invokes `/first-tree-onboarding`, says "onboard this repo to first-tree", "set up first-tree here", "complete first-tree onboarding", or runs first-tree against an unbound repo or workspace. Also trigger when re-running on an already-bound repo to refresh skills, draft missing content, or reverify the daemon. Use this skill instead of running `first-tree tree init` from raw memory; it owns role-by-role branching, the initial-content drafting phase the CLI does NOT do, and the final doctor checks.
---

# First Tree Onboarding (one-shot command)

When the user invokes this skill, you (the agent) drive onboarding **end to end**. Phases A→F below run in order. Within a phase, **execute without asking** unless the action is irreversible or genuinely ambiguous (see "When to ask the user"). At the end, print the wrap-up summary in Phase F.

Read first: [`../first-tree/SKILL.md`](../first-tree/SKILL.md) and [`../first-tree/references/structure.md`](../first-tree/references/structure.md). They define the tree concepts the rest of this skill assumes.

## Success criteria (do not claim done until ALL pass)

1. `first-tree tree inspect --json` (from the source repo) reports `role: source-repo-bound` or `workspace-root-bound`.
2. The bound tree exists on disk, and `first-tree tree verify --tree-path <tree_root>` exits 0.
3. The tree's `NODE.md`, `members/owner/NODE.md`, and `.first-tree/org.yaml` contain real content (no remaining placeholder strings — see [`references/content-drafting.md`](references/content-drafting.md) §Detection).
4. `first-tree tree skill doctor --root <source_root>` exits 0.
5. If the user opted in to the daemon: `first-tree github scan doctor` exits 0.
6. The user has explicitly confirmed which agent templates to keep in `.first-tree/agent-templates/`.

If any of these fails, stop and report — never silently mark onboarding complete.

## When to ask the user (default = act)

Ask **only** before:

- Pushing a branch or PR to a remote (always show diff first).
- Choosing tree mode when both dedicated and shared make sense.
- Recursing into nested repos (`--recursive` cascade) when the workspace contains submodules, vendored code, or private sibling repos.
- Creating a new GitHub repo for the tree (`gh repo create`) — visibility (public/private) must be confirmed.
- Deleting partial state to recover from a corrupt binding.

Everything else: read state, decide, execute, verify. Do not narrate every CLI call to the user — only report at phase boundaries.

## Phases

Each phase has **entry signal → action → exit gate**. If the exit gate fails, stop and surface the error; do not advance.

### Phase A — Pre-flight (always)

**Entry signal:** skill invoked.

**Action:**

1. `first-tree tree inspect --json` from cwd → record `role`, `binding.treeRepoName`, `binding.treeRemoteUrl`, `binding.treeMode`, `binding.bindingMode`, `rootPath`.
2. `first-tree --version` → record CLI version.
3. `gh auth status` → record success/failure (do not stop on failure yet).
4. Compute paths the rest of the skill will use:
   - `source_root` = `rootPath` from inspect.
   - If bound and `treeRepoName` present: `tree_root_candidate` = `<dirname(source_root)>/<treeRepoName>` (dedicated sibling). If that path exists and contains `.first-tree/`, use it as `tree_root`. Otherwise mark `tree_root = unresolved` and resolve in Phase B.

**Branch on `role`:**

| `role`                                       | Next                                                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `tree-repo`                                  | **STOP.** Tell the user: "You're inside the tree repo. cd to the source repo and re-run."             |
| `source-repo-bound` / `workspace-root-bound` | Skip Phase B; jump to Phase B-refresh, then Phase C.                                                  |
| `unbound-source-repo`                        | Phase B (single repo).                                                                                |
| `unbound-workspace-root`                     | Phase B (workspace).                                                                                  |
| `unknown`                                    | Ask: "Not a recognized git repo or workspace. Run `git init` here, or did you mean a different path?" |

**Exit gate:** role classified; `source_root` known; daemon-eligible flag set (gh ok).

### Phase B — Bind (auto unless ambiguous)

**Entry signal:** Phase A reported `unbound-*`.

**Action:**

1. `first-tree tree skill install --root <source_root>` (idempotent).
2. Decide flags. Defaults below — only ask the user if marked ⚠.
   - `unbound-source-repo` → `--tree-mode dedicated`.
   - `unbound-workspace-root` → `--scope workspace --tree-mode shared --workspace-id <slug-of-source-root>`.
   - **⚠ recursion:** if workspace cwd contains nested git repos that look distinct (private repos, submodules, `trusted-external/*`, vendored code), default to `--no-recursive` and **ask** before cascading.
   - **⚠ existing tree:** if user mentioned an existing tree URL, add `--tree-url <url> --tree-mode shared` and skip `--tree-mode dedicated`.
3. `first-tree tree init <flags>`.
4. Resolve `tree_root` from the binding written by `tree init`. For dedicated mode it is the sibling dir; for `--tree-url` it is the temp clone under `<source_root>/.first-tree/tmp/<treeRepoName>/`.
5. `first-tree tree verify --tree-path <tree_root>`.

**Exit gate:** `tree verify` exits 0. `tree inspect --json` now reports `role: source-repo-bound` or `workspace-root-bound`.

### Phase B-refresh — Already bound (auto)

**Entry signal:** Phase A reported `*-bound`.

**Action:**

1. `first-tree tree skill upgrade --root <source_root>` (idempotent, picks up newer shipped skills).
2. `first-tree tree workspace sync` only if role is `workspace-root-bound` (re-discovers child repos; safe to rerun).
3. `first-tree tree verify --tree-path <tree_root>`.

**Exit gate:** verify passes. Continue to Phase C.

### Phase C — Draft initial tree content (auto)

**Entry signal:** any of:

- `<tree_root>/NODE.md` body still contains the literal string `"The living source of truth for your organization"`, OR
- `<tree_root>/members/owner/NODE.md` still contains `"Default bootstrap member node"`, OR
- `<tree_root>/.first-tree/org.yaml` `companyContext.industry` is the empty string `""`.

If none match → skip Phase C. The combined check is reliable because all three placeholders come from the CLI's bootstrap templates — the moment a human or agent has drafted real content, at least one will have changed.

**Action:** follow [`references/content-drafting.md`](references/content-drafting.md) verbatim. Summary:

1. Open the tree on disk (already resolved as `tree_root` in Phase A/B).
2. `git -C <tree_root> checkout -b chore/initial-content-draft` (if not already on it).
3. Read source signals: `README.md`, top-level dir layout, `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` / etc., recent `git log --since='6 months ago' --format='%aN <%aE>'`, `gh repo view --json description,topics,homepageUrl` (if gh ok).
4. For each tree field listed in `content-drafting.md` §Extraction Rules, run the matching rule. Mark every field with `# unverified — source: <where>` if confidence is low. **Never invent facts not present in the source signals.**
5. `git -C <tree_root> diff --staged` and present to user. Get explicit "yes" before remote actions.
6. `git -C <tree_root> commit` → `git -C <tree_root> push -u origin chore/initial-content-draft` → `gh pr create --repo <slug> --title "..." --body "..."` (or, if user prefers, push to `main` directly — ask).
   **Exit gate:** all three placeholder strings from the entry signal are gone in the on-disk tree. If the user chose the PR flow and the PR is still open (not merged), treat Phase C as **deferred** — print the deferred summary in Phase F and exit; the user re-runs `/first-tree-onboarding` after merging to finish the remaining phases.

### Phase D — GitHub Scan daemon (auto if gh ok; otherwise stop here)

**Entry signal:** Phase C exit gate passed.

**Action:**

1. If gh auth failed in Phase A: stop. Tell user `gh auth login`, do not attempt install. Skip to Phase E only when the user explicitly says "skip the daemon".
2. Ask once: "Install the GitHub Scan daemon for `<owner/repo>`? It polls notifications and dispatches PR-driven tree updates. (yes/skip)". Default = yes.
3. Decide `--allow-repo`: start with the bound source repo only — `<owner>/<repo>`. Wider globs are a follow-up the user opts into later.
4. `first-tree github scan install --allow-repo <owner/repo>`.
5. `first-tree github scan doctor`.

**Exit gate:** `doctor` exits 0, OR user explicitly opted out (record this in the wrap-up summary).

### Phase E — Agent templates (auto verify; ask only on add/drop)

**Entry signal:** Phase D done or skipped.

**Action:**

1. List `<tree_root>/.first-tree/agent-templates/`. Confirm `developer.yaml` and `code-reviewer.yaml` exist (CLI wrote them in Phase B).
2. Ask: "Keep developer + code-reviewer? Add custom roles (designer / qa / etc.)?"
3. Apply changes per [`references/agent-templates.md`](references/agent-templates.md). For drops: `git rm`. For adds: copy `developer.yaml` as schema and edit the prompt + skills list.
4. Commit any changes to the tree.

**Exit gate:** user has confirmed the roster.

### Phase F — Wrap-up (always)

**Action:**

1. `first-tree tree skill doctor --root <source_root>` → must exit 0.
2. `first-tree github scan doctor` if Phase D ran → must exit 0.
3. `first-tree tree inspect --json` → confirm `role` is `*-bound`.
4. Print the summary. Format:

   ```
   First Tree onboarding complete.

   Source repo: <source_root>
   Tree repo:   <tree_root> (<bindingMode>, <treeMode>)
   Tree URL:    <treeRemoteUrl or "not published">
   Daemon:      <running for <owner/repo> | skipped>
   Agents:      <comma-separated template names>

   Next:
   - Edit <tree_root>/.first-tree/org.yaml to fill in stage/industry if marked unverified.
   - Open a PR in the source repo to see github scan dispatch the developer agent.
   - Run /first-tree-sync any time you suspect tree drift.
   ```

## Edge cases (inline rules)

| Situation                                                                          | Rule                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm install -g first-tree@latest` errors with `Unsupported URL Type "workspace:"` | Don't retry. Fall back to building from a local `agent-team-foundation/first-tree` checkout: `pnpm install && pnpm --filter first-tree build`, then run via `node <repo>/apps/cli/dist/index.js`.                                                       |
| `gh auth status` fails                                                             | Stop at Phase D entry. Don't install daemon. Don't push tree branches in Phase C — keep work local until `gh auth login`.                                                                                                                               |
| `tree init` exits 0 but `inspect` still shows `unbound-*`                          | Read source `AGENTS.md` for the managed `FIRST-TREE-SOURCE-INTEGRATION` block. If absent → re-run `tree init`. If present but corrupt (missing `BINDING-MODE` or `TREE-REPO`) → ask user before deleting and re-running. Never patch the block by hand. |
| `tree verify` fails after Phase B                                                  | Print the failures, stop. Most common cause: the sibling tree dir was created but `tree init` was interrupted mid-write. Recovery: `rm -rf <tree_root>` then re-run `tree init`. **Always ask before rm.**                                              |
| Phase C: source repo has no README and < 5 commits                                 | Generate the minimal scaffolding-replacement (real domain list from top-level dirs only) and mark every other field `# unverified — source repo too sparse to infer`. Open the PR anyway so the user can fill in.                                       |
| Phase C: tree was published to remote but local sibling dir is missing             | Clone to `<source_root>/.first-tree/tmp/<treeRepoName>/` per the source `AGENTS.md` managed block fallback. Use that as `tree_root` for Phase C. After commit/push, **delete the temp clone**.                                                          |
| Workspace root has many nested repos                                               | Default `--no-recursive`. List the nested repos to the user and ask which to bind. Only cascade when the user confirms.                                                                                                                                 |
| User re-runs the skill on already-bound repo                                       | Phase A → Phase B-refresh → Phase C (will skip if progress.md is fully checked) → Phase F. The skill is idempotent.                                                                                                                                     |
| Tree on a private GitHub org, gh user lacks repo-create scope                      | Skip `gh repo create` in Phase B. Commit locally and tell the user the manual `git remote add origin … && git push -u origin main` steps.                                                                                                               |
| Source repo and tree repo are on different GitHub accounts                         | Ask once which account the tree should live under. Default = same owner as source.                                                                                                                                                                      |

## Hard rules (never violate)

- **Never edit the managed First Tree blocks** (`<!-- BEGIN FIRST-TREE-* -->`) by hand. Re-run the relevant CLI (`tree init`, `tree publish`, `tree workspace sync`).
- **Never push to the tree's main branch without an explicit "yes"** from the user. Default for Phase C content is a PR.
- **Never start an agent runtime in Phase E.** Templates only. The daemon spawns agents.
- **Never claim onboarding done if any Phase F doctor exits non-zero.**
- **Never run onboarding inside a tree repo** (`role: tree-repo`). Stop and explain.
- **Never invent content in Phase C.** If a fact isn't in the source signals listed in `content-drafting.md`, leave the field empty with a `# unverified` marker.
- **Never bypass `gh auth status` failures** by hand-crafting tokens. Stop and instruct the user.

## References

- [`references/recipe.md`](references/recipe.md) — exact commands and verification per phase.
- [`references/content-drafting.md`](references/content-drafting.md) — Phase C extraction rules, confidence labels, tree-path resolution, PR flow.
- [`references/role-decisions.md`](references/role-decisions.md) — role × action matrix used by Phase A.
- [`references/agent-templates.md`](references/agent-templates.md) — Phase E template schema and add/drop rules.
- [`references/cli-quickref.md`](references/cli-quickref.md) — every CLI invocation this skill makes, in one place.
