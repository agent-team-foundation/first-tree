# Workspace Position Decision Table

`first-tree tree status --json` reports a W1 workspace shape, or exits 1
when no `workspace.json` exists at or above cwd. This table is the
contract for what comes next in the SKILL.md state machine.

## W1 (workspace-rooted) shapes

| `tree status` shape                                                                    | What it means                                                                                                                                                                                                  | Next phase (per SKILL.md)                                                                                                                                          |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reports `workspaceRoot` + `manifest.tree` + non-empty `boundSources[]`                 | Cwd is at or under a W1 workspace root with a tree and at least one bound source.                                                                                                                              | Phase B-refresh → Phase C → Phase D → Phase E. The skill is idempotent: skill upgrade + verify + draft missing content + re-check the rule layer.                  |
| Exits 1 with "No First Tree workspace found"                                            | Cwd is not under any W1 workspace. Branch by what's on disk: a single git repo at cwd → pre-create a workspace dir, `mv` the source into it, `cd` in, and run `first-tree tree init --scope workspace --tree-path ./<tree> --tree-mode dedicated --workspace-id <slug>` (swap `--tree-mode dedicated` for `--tree-mode shared --tree-url <url>` to bind an existing remote tree). A workspace root with multiple child repos already in place → `first-tree tree init --scope workspace --tree-mode shared --workspace-id <slug>`, then add siblings to `sources` by editing `workspace.json`. If legacy markers exist on disk (`.first-tree-workspace`, `<tree>/.first-tree/bindings/`, or `<source>/.first-tree/source.json`), go to Phase A.5 first. | Phase B (new workspace) OR Phase A.5 (legacy 0.5.x → W1 migration).                                                                                                  |
| `unboundGitSiblings[]` non-empty (W1 workspace + new repo cloned in)                   | A new repo appeared next to the tree but is not yet in `workspace.json.sources`.                                                                                                                                | Phase B-refresh: ask the user whether to add it to `sources`. Adding is a direct edit to the JSON file. No CLI command needed.                                     |
| `boundSources[?].present === false` (workspace + bound source not cloned locally)      | The manifest declares a source but the subdir does not exist on disk.                                                                                                                                          | Ask the user to `git clone <remoteUrl> <name>` next to the tree, or remove that entry from `sources`. Do not silently drop it.                                     |

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
