# `first-tree tree`

CLI toolkit for creating, binding, and maintaining a Context Tree repo.

## What's In This Directory

```text
tree/
├── VERSION                # product semver (independent of npm package)
├── README.md              # product overview
├── cli.ts                 # thin arg-routing dispatcher (lazy-loads commands)
└── engine/
    ├── commands/          # one file per subcommand (bind, init, bootstrap, publish, …)
    ├── rules/             # tree validation rules
    ├── runtime/           # asset loader, installer, upgrader, source integration
    ├── validators/        # node + member validators
    └── (domain modules)   # bind.ts, init.ts, integrate.ts, publish.ts, …
```

## Commands

| Command | Role |
|---------|------|
| `first-tree tree inspect` | Classify the current folder (source / workspace / tree) |
| `first-tree tree status` | Human-friendly alias for `inspect` |
| `first-tree tree init` | Primary onboarding wrapper for new trees or existing shared trees |
| `first-tree tree bootstrap` | Canonical low-level tree bootstrap for an explicit tree checkout |
| `first-tree tree bind` | Lower-level binding primitive when you need explicit binding-mode control |
| `first-tree tree integrate` | Install local skill integration and source-integration files without mutating the tree repo |
| `first-tree tree workspace sync` | Bind newly added child repos to a shared tree, or rerun workspace-member binding manually |
| `first-tree tree publish` | Push the tree to GitHub and refresh bound sources |
| `first-tree tree verify` | Run validation checks on a tree repo |
| `first-tree tree upgrade` | Refresh installed source/tree integration from the package |
| `first-tree tree generate-codeowners` | Generate `.github/CODEOWNERS` from tree ownership |
| `first-tree tree review` | PR review helper for tree repos in CI |
| `first-tree tree inject-context` | Claude Code SessionStart payload from root `NODE.md` |
| `first-tree tree invite` | Invite a new member to the Context Tree |
| `first-tree tree join` | Accept an invite and join a Context Tree |
| `first-tree tree help onboarding` | Print the full onboarding guide |
| `first-tree gardener sync` | Drift-detection command for bound source repos (moved out of the tree namespace) |

Run `first-tree tree --help` for the authoritative list.

## Related

- User-facing skill: [`skills/tree/SKILL.md`](../../../skills/tree/SKILL.md)
- Runtime assets shipped to user repos: [`assets/tree/`](../../../assets/tree)
- Tests: [`tests/tree/`](../../../tests/tree)
- Architecture notes: [`docs/architecture/overview.md`](../../../docs/architecture/overview.md)
