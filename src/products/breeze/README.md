# `first-tree breeze`

Local daemon that takes over your `gh` login and turns GitHub notifications
(PRs, comments, discussions, issues) into a triaged, optionally auto-handled
inbox. Drives a Claude Code statusline, an SSE dashboard, and scheduled
background work.

## What's In This Directory

```text
breeze/
├── VERSION
├── README.md              # product overview
├── cli.ts                 # dispatcher
└── engine/
    ├── commands/          # install, start, stop, poll, watch, doctor, cleanup, status, status-manager
    ├── daemon/            # long-lived process: broker, bus, claim, dispatcher, poller, runner, scheduler, …
    ├── runtime/           # classifier, config, identity helpers
    ├── bridge.ts          # integration with the umbrella CLI
    └── statusline.ts      # zero-dep bundle consumed by the Claude Code statusline hook
```

## Commands

### Primary

| Command | Role |
|---------|------|
| `first-tree breeze install` | Check `gh` / `jq` / auth, create `~/.breeze/config.yaml`, and start the daemon. Statusline hook wiring is a separate manual step. |
| `first-tree breeze start/stop` | Control the daemon lifecycle |
| `first-tree breeze status` | Print current daemon/runtime status |
| `first-tree breeze doctor` | Diagnose daemon / gh login / runtime health |
| `first-tree breeze watch` | Interactive TUI inbox (Ink) |
| `first-tree breeze poll` | One-shot inbox poll without requiring the daemon |

### Advanced / internal

| Command | Role |
|---------|------|
| `first-tree breeze run` / `first-tree breeze daemon` | Run the broker loop in the foreground |
| `first-tree breeze run-once` | Run one poll cycle, wait for drain, then exit |
| `first-tree breeze cleanup` | Clear stale state |
| `first-tree breeze statusline` | CLI shim that executes the pre-bundled `dist/breeze-statusline.js` hook |
| `first-tree breeze status-manager` | Internal helper used by breeze runners |
| `first-tree breeze poll-inbox` | Legacy alias for `poll` |

Run `first-tree breeze --help` for the authoritative list.

Daemon-starting commands (`install`, `start`, `run`, `daemon`, `run-once`)
must be given `--allow-repo <owner/repo[,owner/*,...]>` so breeze never
falls back to scanning every notification on the account.

## Runtime Constraints

`engine/statusline.ts` is bundled separately (`dist/breeze-statusline.js`) and
is called every few seconds by the Claude Code statusline hook. It must stay
zero-dep and cold-start under 30ms — do not import `ink`, `zod`, or the
umbrella CLI from it.

## Related

- User-facing skill: [`skills/breeze/SKILL.md`](../../../skills/breeze/SKILL.md)
- Assets (SSE dashboard HTML): [`assets/breeze/`](../../../assets/breeze)
- Tests: [`tests/breeze/`](../../../tests/breeze)
