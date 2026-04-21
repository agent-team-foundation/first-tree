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
    └── (domain modules)   # bind.ts, init.ts, sync.ts, publish.ts, …
```

## Commands

| Command | Role |
|---------|------|
| `first-tree tree inspect` | Classify the current folder (source / workspace / tree) |
| `first-tree tree init` | High-level onboarding wrapper |
| `first-tree tree bootstrap` | Canonical low-level tree bootstrap for an explicit tree checkout |
| `first-tree tree bind` | Bind current repo/workspace to an existing tree |
| `first-tree tree workspace sync` | Bind discovered local child repos to a shared tree |
| `first-tree tree publish` | Push the tree to GitHub and refresh any explicit or locally discoverable bound sources |
| `first-tree tree verify` | Run validation checks on a tree repo |
| `first-tree tree upgrade` | Refresh installed source/tree integration from the package |
| `first-tree tree generate-codeowners` | Generate `.github/CODEOWNERS` from tree ownership |
| `first-tree tree review` | PR review helper for tree repos in CI |
| `first-tree tree inject-context` | Claude Code SessionStart payload from root `NODE.md` |
| `first-tree tree help onboarding` | Print the full onboarding guide |

Run `first-tree tree --help` for the authoritative list.

## Related

- User-facing skill: [`skills/tree/SKILL.md`](../../../skills/tree/SKILL.md)
- Runtime assets shipped to user repos: [`assets/tree/`](../../../assets/tree)
- Tests: [`tests/tree/`](../../../tests/tree)
- Architecture notes: [`docs/architecture/overview.md`](../../../docs/architecture/overview.md)
