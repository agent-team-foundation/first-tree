# Workspace Position Decision Table

`first-tree tree status --json` reports a workspace shape under W1, or
falls back to the legacy `role` enum for unmigrated workspaces. This
table is the contract for what comes next in the SKILL.md state machine.

## W1 (workspace-rooted) shapes

| `tree status` shape                                                                    | What it means                                                                                                                                                                                                  | Next phase (per SKILL.md)                                                                                                                                          |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reports `workspaceRoot` + `manifest.tree` + non-empty `boundSources[]`                 | Cwd is at or under a W1 workspace root with a tree and at least one bound source.                                                                                                                              | Phase B-refresh → Phase C. The skill is idempotent: skill upgrade + verify + draft missing content + reverify daemon.                                              |
| "not inside a First Tree workspace" (no `workspace.json` on the path)                  | Cwd is unbound. Decide between lone-source and workspace setup by what's on disk: a single git repo at cwd is `init --tree-mode dedicated` (or `--tree-url <url>` for an existing tree); a workspace root with multiple child repos uses `init --scope workspace --tree-mode shared --workspace-id <slug>`, then adds siblings to `sources` by editing `workspace.json`. | Phase B (single repo) or Phase B (workspace). Default to NOT recursing into nested git repos.                                                                       |
| `unboundGitSiblings[]` non-empty (W1 workspace + new repo cloned in)                   | A new repo appeared next to the tree but is not yet in `workspace.json.sources`.                                                                                                                                | Phase B-refresh: ask the user whether to add it to `sources`. Adding is a direct edit to the JSON file. No CLI command needed.                                     |
| `boundSources[?].present === false` (workspace + bound source not cloned locally)      | The manifest declares a source but the subdir does not exist on disk.                                                                                                                                          | Ask the user to `git clone <remoteUrl> <name>` next to the tree, or remove that entry from `sources`. Do not silently drop it.                                     |

## Legacy multi-mode `role` values (only during migration)

`first-tree tree status` returns these when no `workspace.json` exists
but the legacy `inspect` reporter finds a binding. These shapes mean the
workspace has not been migrated to W1 yet — Phase A.5 (`migrate-to-w1`)
must run before any other onboarding phase.

| `role`                   | What it means                                                                                                                           | Next step                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unbound-source-repo`    | Current dir is a git repo with no first-tree binding and is not a workspace root.                                                       | Phase B (single repo).                                                                                                                                     |
| `unbound-workspace-root` | Current dir contains multiple direct child repos, each with `.git/`, but the root itself is not bound.                                  | Phase B (workspace).                                                                                                                                       |
| `source-repo-bound`      | Already bound as a single repo (legacy `shared-source` or `standalone-source` mode).                                                    | Phase A.5: run `first-tree tree migrate-to-w1 --dry-run` from the source dir. For Case B/C single-repo layouts the migrate command will promote into a workspace dir. |
| `workspace-root-bound`   | Workspace root already bound (legacy `workspace-root` mode).                                                                            | Phase A.5: run `first-tree tree migrate-to-w1 --dry-run` from the workspace root.                                                                          |
| `tree-repo`              | Current dir is the tree repo itself (`NODE.md` + `members/NODE.md`).                                                                    | **STOP.** Onboarding does not run inside the tree subdir. Tell the user to cd to the workspace root and re-run.                                            |
| `unknown`                | Not a git repo and not a recognized workspace shape.                                                                                    | Ask the user once: "Run `git init` here, or did you point onboarding at the wrong path?" Do not auto-convert.                                              |

## Workspace Detection Notes

W1's `tree status` walks up from `cwd` looking for the closest ancestor
with `.first-tree/workspace.json`. A workspace at `<root>/` is visible
from `<root>/source-a/anything/here/`. A nested layout like
`<root>/repos/repo-a/.git` is **not** automatically recognized as a
workspace; if the user expects workspace behavior there, ask them to
either flatten it or point onboarding at the inner directory.

## Existing-Binding Sanity Check (W1)

For W1 workspaces, read the manifest as ground truth:

- `manifest.tree` is the immediate subdir name of the tree under
  `workspaceRoot`.
- `manifest.sources` is the canonical list of bound source subdir names.
- `boundSources[?].remoteUrl` tells you the GitHub URL for each source.

When `workspace.json` is malformed (schema violation surfaced by status
or verify), treat the binding as corrupt: do not patch the JSON by hand.
Either restore from git history (`git checkout` the manifest from a
known-good commit in the workspace's host repo, if one exists) or
re-run `first-tree tree init` with the right flags.

## When status disagrees with user intent

If the user says they want a workspace but `tree status` reports a lone
source repo (or vice versa), do not force the other shape. Either:

- ask whether the user meant to point onboarding at a parent directory; or
- accept the current shape and onboard accordingly.

Forcing the wrong shape produces a binding that other commands will reject
later.
