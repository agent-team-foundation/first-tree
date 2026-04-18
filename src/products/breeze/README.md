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

| Command | Role |
|---------|------|
| `first-tree breeze install` | Set up the daemon (launchd on macOS) and Claude Code hooks |
| `first-tree breeze start/stop` | Control the daemon lifecycle |
| `first-tree breeze run-once` | One-shot poll for scripting |
| `first-tree breeze status` | Print current inbox status |
| `first-tree breeze watch` | Interactive TUI inbox (Ink) |
| `first-tree breeze doctor` | Diagnose daemon / gh login / hook health |
| `first-tree breeze cleanup` | Clear stale state |

Run `first-tree breeze --help` for the authoritative list.

## Runtime Constraints

`engine/statusline.ts` is bundled separately (`dist/breeze-statusline.js`) and
is called every few seconds by the Claude Code statusline hook. It must stay
zero-dep and cold-start under 30ms — do not import `ink`, `zod`, or the
umbrella CLI from it.

## Related

- User-facing skill: [`skills/breeze/SKILL.md`](../../../skills/breeze/SKILL.md)
- Assets (SSE dashboard HTML): [`assets/breeze/`](../../../assets/breeze)
- Tests: [`tests/breeze/`](../../../tests/breeze)
