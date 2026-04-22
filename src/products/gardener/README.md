# `first-tree gardener`

Maintenance agent for Context Trees. Gardener owns three kinds of runtime:

- **drift sync** — `first-tree gardener sync`
- **source-repo verdict comments** — `first-tree gardener comment`
- **sync-PR review responses** — `first-tree gardener respond`

It can run in two deployment shapes:

- **Push mode** — `first-tree gardener install-workflow` scaffolds the
  `.github/workflows/first-tree-sync.yml` GitHub Actions workflow in a codebase
  repo.
- **Pull mode** — `first-tree gardener start` / `run-once` / `status` / `stop`
  manage the local daemon that schedules `comment` and `sync`.

## What's In This Directory

```text
gardener/
├── VERSION
├── README.md              # product overview
├── cli.ts                 # dispatcher
└── engine/
    ├── commands/          # sync, comment, respond, install-workflow, start, stop, status, run-once, daemon
    ├── daemon/            # launchd config, loop orchestration, runtime state
    ├── runtime/           # config helpers
    └── (domain modules)   # sync, comment builder, responder, install-workflow, open-tree-pr orchestration, …
```

## Commands

### Primary

| Command | Role |
|---------|------|
| `first-tree gardener install-workflow` | Scaffold the push-mode GitHub Actions workflow in a codebase repo |
| `first-tree gardener start/stop` | Control the pull-mode gardener daemon |
| `first-tree gardener status` | Report daemon PID, schedule, and last-run state |
| `first-tree gardener run-once` | Execute both sweeps inline and exit |

### Agent / CI

| Command | Role |
|---------|------|
| `first-tree gardener sync` | Detect drift between a tree repo and its bound sources; optionally propose/apply tree PRs |
| `first-tree gardener comment --pr <n> --repo owner/name` | Review a source PR against the tree and post a verdict |
| `first-tree gardener comment --issue <n> --repo owner/name` | Same, for an issue |
| `first-tree gardener respond --pr <n> --repo owner/name` | Handle reviewer feedback on a sync PR |
| `first-tree gardener daemon` | Foreground loop invoked by `start` |

Run `first-tree gardener --help` for the authoritative list.

## Related

- User-facing skill: [`skills/gardener/SKILL.md`](../../../skills/gardener/SKILL.md)
- Tests: [`tests/gardener/`](../../../tests/gardener)
- Gardener has no shipped `assets/` — it's a pure runtime tool.
