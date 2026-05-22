# Role Decision Table

`first-tree tree inspect --json` reports one of six `role` values. This table maps each role to the next phase in the SKILL.md state machine. The mapping is the contract — not a guideline.

| `role`                   | What it means                                                                                                                           | Next phase (per SKILL.md)                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unbound-source-repo`    | Current dir is a git repo with no first-tree binding and is not a workspace root.                                                       | Phase B (single repo). Default `--tree-mode dedicated`. If the user has an existing tree, switch to `--tree-url <url> --tree-mode shared`.        |
| `unbound-workspace-root` | Current dir contains multiple direct child repos, each with `.git/`, but the root itself is not bound.                                  | Phase B (workspace). Default `--scope workspace --tree-mode shared --workspace-id <slug> --no-recursive`. Ask before recursing into nested repos. |
| `source-repo-bound`      | Already bound as a single repo.                                                                                                         | Phase B-refresh → Phase C. The skill is idempotent: skill upgrade + verify + draft missing content + reverify daemon.                             |
| `workspace-root-bound`   | Workspace root already bound.                                                                                                           | Phase B-refresh (with `tree workspace sync`) → Phase C.                                                                                           |
| `tree-repo`              | Current dir is the tree repo itself (`NODE.md` + `members/NODE.md`, plus the managed tree identity block in `AGENTS.md` / `CLAUDE.md`). | **STOP.** Onboarding does not run inside the tree repo. Tell the user to cd to the source repo and re-run.                                        |
| `unknown`                | Not a git repo and not a recognized workspace shape.                                                                                    | Ask the user once: "Run `git init` here, or did you point onboarding at the wrong path?" Do not auto-convert.                                     |

## Workspace Detection Notes

`unbound-workspace-root` only fires when the _direct_ children of the current
directory contain at least two `.git` markers. A nested layout like
`<root>/repos/repo-a/.git` does not count. If the user expects workspace
behavior on a nested layout, ask them to either flatten it or point
onboarding at the inner directory.

## Existing-Binding Sanity Check

If `role` is `*-bound`, also read the `binding` block returned by inspect:

- `binding.bindingMode` confirms the mode (`standalone-source`,
  `shared-source`, `workspace-root`, `workspace-member`).
- `binding.treeRepoName` and `binding.treeMode` confirm the tree.

When any field is missing, treat the binding as corrupt and re-run
`first-tree tree init` with the right flags rather than patching the JSON
manually.

## When `inspect` Disagrees With User Intent

If the user says they want a workspace but inspect reports
`unbound-source-repo`, do not force `--scope workspace`. Either:

- ask whether the user meant to point onboarding at a parent directory; or
- accept the current scope and onboard as a single source repo.

Forcing the wrong scope produces a binding that other commands will reject
later.
