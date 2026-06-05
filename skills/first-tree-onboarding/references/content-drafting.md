# Content Drafting (Phase C)

Phase C is the agent-driven step that takes a freshly-init'd tree from "scaffolding only" to "real content drawn from the source repo". The CLI does not do this — the LLM does. This file defines exactly how.

## Detection

Phase C **fires** when any of these placeholder signals match:

- `<tree_root>/NODE.md` body contains the literal `"The living source of truth for your organization"`.
- `<tree_root>/members/owner/NODE.md` contains `"Default bootstrap member node"`.
- `<tree_root>/.first-tree/org.yaml`'s `companyContext.industry` is the empty string `""`.

Phase C **skips** when none of these strings appear. The signals come straight from the CLI's bootstrap templates — the moment a human or agent has drafted real content, at least one of them is gone.

This makes the phase idempotent — the agent can re-run the skill at any time and Phase C only does real work when there's real work to do. Do not use `<tree_root>/.first-tree/progress.md` as a Phase C signal; that file is owned by the CLI's bootstrap checklist and `tree verify` requires every line in it to be ticked. Adding an agent-driven todo there would break `init → verify`.

## Tree-on-disk resolution

Under W1, the tree path is computed directly from the workspace
manifest. Read `tree status --json` once and derive everything from
the response:

```bash
STATUS=$(first-tree tree status --json)
WORKSPACE_ROOT=$(echo "$STATUS" | jq -r '.workspaceRoot')
TREE_ROOT="$WORKSPACE_ROOT/$(echo "$STATUS" | jq -r '.manifest.tree')"
```

`TREE_ROOT` is always the immediate child of `WORKSPACE_ROOT` named
by `manifest.tree`. There is no sibling-vs-child branch under W1; the
sibling layout was consolidated by `migrate-to-w1` before Phase C
runs (Phase A.5 in `SKILL.md`).

If `tree status` exits non-zero (no `workspace.json` present),
onboarding never bound this workspace. Stop and go back to Phase B
(or Phase A.5 if legacy markers exist on disk). Phase C must not run
against an unbound workspace.

Use absolute paths. Never `cd` — always pass `git -C $TREE_ROOT`.

## Source signals (what to read)

Read **only** these. Do not browse arbitrarily.

For each bound source repo `SOURCE_ROOT = $WORKSPACE_ROOT/$NAME`
(iterate `manifest.sources` or `boundSources[].name`), read **only**
these signals. Do not browse arbitrarily.

| Signal              | Command / path                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project description | `$SOURCE_ROOT/README.md` (or `Readme.md` / `README` — first match) — first H1 + first paragraph                                                                                                                     |
| Top-level layout    | `ls -1 $SOURCE_ROOT` filtered to dirs, excluding `.git`, `node_modules`, `.venv`, `dist`, `build`, `target`, `.next`, `.turbo`                                                                                      |
| Manifest tech stack | First-found of: `package.json` (deps + devDeps top-level keys), `pyproject.toml` (`[project.dependencies]`), `Cargo.toml` (`[dependencies]`), `go.mod` (`require` block), `Gemfile`, `pom.xml`, `requirements*.txt` |
| Recent contributors | `git -C $SOURCE_ROOT log --since='6 months ago' --format='%aN <%aE>' \| sort \| uniq -c \| sort -rn \| head -20`                                                                                                    |
| Repo metadata       | `gh repo view --json description,topics,homepageUrl,defaultBranchRef` from `$SOURCE_ROOT` (skip if `gh auth status` failed)                                                                                         |
| Workspace children  | `manifest.sources` from `tree status --json` is the canonical list. Each bound source `$NAME` is a sibling of `$TREE_ROOT` at `$WORKSPACE_ROOT/$NAME`.                                                              |

If any signal is missing or empty, that's fine — record "unavailable" and lower confidence on dependent fields.

## Extraction rules (signal → tree field)

For each output field below, apply the rule. Confidence is `high` / `medium` / `low`. Mark every `low` field with `# unverified — source: <signal>` so the user knows what to review.

### `<tree_root>/NODE.md`

| Tree field            | Rule                                                                                                                                                                                                                                                                                | Confidence                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Root routing skeleton | Under `## Domains`, add one bullet per observed top-level source area worth registering as a domain candidate. Skip build artifacts (`dist`, `node_modules`, `.next`, `.venv`). Preserve supporting groups such as `## Members`; do not list them as domains. | medium                                    |
| Description paragraph | Verbatim from README first paragraph if it's <= 3 sentences. Otherwise summarize in <= 30 words and quote source.                                                                                                                                                                  | high if README exists; low if synthesized |

Do **not** invent domains or root groups that do not exist in the source
signals. If the repo has only `src/`, the tree has only one domain
candidate — that's correct.

### `<tree_root>/members/owner/NODE.md`

| Tree field            | Rule                                                                                                                                                                            | Confidence |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `title` frontmatter   | Most-frequent contributor's `%aN` from `git log`                                                                                                                                | high       |
| Body                  | One sentence: "Owner of the `<source_repo>` source repo." Plus a `## Recent contributors` list (top 5 from `git log` with commit counts), each as `- Name <email> (N commits)`. | high       |
| `domains` frontmatter | Default `[core]`. Only override if user has named multiple domains (rare in initial draft).                                                                                     | high       |

Do **not** create new `members/<name>/` nodes for other contributors in the initial draft — the owner-only roster is the safe default. Adding more members is a follow-up the user does explicitly.

### `<tree_root>/.first-tree/org.yaml`

| Tree field                                       | Rule                                                                                                                                                                                    | Confidence |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `companyContext.industry`                        | Inferred from README first paragraph + repo description + topics. Set to a single phrase (`"developer tools"`, `"data infra"`, etc.). If unclear, leave `""` and add `# unverified`.    | low        |
| `companyContext.stage`                           | If `package.json` `version` < `0.1.0` → `"prototype"`. If between `0.1.0` and `1.0.0` → `"alpha"`. If ≥ `1.0.0` → `"production"`. If no version field → leave `""` with `# unverified`. | medium     |
| `companyContext.techStackConstraints`            | Top 5 entries from manifest deps (the most-used languages/frameworks). Format: `- <name>` (e.g., `- typescript`, `- react`, `- postgres`).                                              | high       |
| `companyContext.culture`                         | Leave `[]` with comment `# unverified — culture is a human input`.                                                                                                                      | always low |
| `agents`                                         | Leave `[]`. Runtime tooling (outside this skill) writes here; not a Phase C draft target.                                                                                               | n/a        |
| `collaboration.routing` / `collaboration.review` | Leave `[]` with `# unverified — author later`.                                                                                                                                          | n/a        |
| `humanInvolveRules.defaults`                     | Keep the default 3 entries.                                                                                                                                                             | high       |

### `<tree_root>/source-repos.md`

Legacy index. Under W1 the canonical bound-source list lives in
`<workspaceRoot>/.first-tree/workspace.json`'s `sources` field, and
agents read that directly via `first-tree tree status --json`. **Do
not write `source-repos.md` by hand in Phase C.** If it still exists
in a pre-migration tree, the next `first-tree tree migrate-to-w1` run
removes it as part of cleanup.

### `<tree_root>/AGENTS.md` and `<tree_root>/CLAUDE.md`

Both contain managed blocks (`<!-- BEGIN FIRST-TREE-TREE-IDENTITY -->` and others). **Phase C does not touch these.** They are owned by the CLI.

The free-form section below `# Project-Specific Instructions` IS editable in Phase C, but only add content if the source repo has a non-trivial AGENTS.md / CLAUDE.md whose content is worth carrying over to the tree's instructions. Otherwise leave the placeholder comment alone.

## Confidence and `# unverified` markers

Every field marked `low` confidence must include an inline comment in the file:

```yaml
companyContext:
  industry: "" # unverified — source: README.md has no industry signal
  stage: "alpha" # unverified — package.json version 0.3.1 → alpha (medium confidence)
```

For markdown nodes, use HTML comments at the end of the line or paragraph:

```markdown
The bingran-you workspace hosts agent infrastructure prototypes. <!-- unverified — synthesized from README L1-3 -->
```

These comments are intentional: they tell the user where to review and why.

## Delivery (commit, branch, PR)

Default flow — **always show diff before remote actions**:

1. `git -C <tree_root> checkout -b chore/initial-content-draft`
2. Make all edits, then `git -C <tree_root> add -A` and `git -C <tree_root> diff --staged`.
3. **Stop and show the diff to the user.** Wait for "yes / no / edit X" before any remote action.
4. On approval:
   - `git -C <tree_root> commit -m "chore: draft initial tree content from source signals" -m "$BODY"` where `$BODY` lists the source signals used per field.
   - `git -C <tree_root> push -u origin chore/initial-content-draft`
   - `gh pr create --repo <owner/treeRepo> --title "Draft initial tree content" --body "..."` — body must list per-field provenance and flag every `# unverified` field for the user to review.
5. After the PR is open (or merged, if the user prefers direct push to main): do **not** modify `progress.md` — that file is the CLI's bootstrap checklist and any unchecked line there will fail `tree verify`. Phase C state is observed via the placeholder strings in §Detection.

If the tree is not yet published to a remote (Phase B happened on a fresh local-only sibling), commit locally and tell the user how to publish + push the branch manually. Don't run `gh repo create` without explicit user approval.

## Cleanup

Under W1 the tree is always a real sibling of the source(s) at `$WORKSPACE_ROOT/$(manifest.tree)`, not a temporary clone. No tmp-clone cleanup is needed at the end of Phase C.

## Idempotency

Re-running Phase C on an already-drafted tree is safe:

- Detection signals all evaluate false → Phase C skips.
- If a partial draft landed (e.g., NODE.md and members/owner/NODE.md were rewritten but `org.yaml` `companyContext.industry` is still the empty string), Phase C re-fires and writes only the fields whose placeholder still matches. Re-read source signals, re-apply rules for the missing fields, generate a follow-up commit, open another PR.

Never overwrite content that has already been edited (signal: the placeholder string is gone AND no `# unverified` marker remains on that field). Treat that as "human-finalized".

## What Phase C does NOT do

- Does not install GitHub automation workflows (that's Phase D).
- Does not register source repos. Source binding lives in `<workspaceRoot>/.first-tree/workspace.json`'s `sources` field and is edited as a direct JSON change (or by the runtime / human adding a sibling).
- Does not run any LLM call beyond what the agent itself does. There is no separate LLM service the skill calls.
- Does not deduce facts not present in the source signals listed above. If something can't be inferred, leave it empty with `# unverified`.
