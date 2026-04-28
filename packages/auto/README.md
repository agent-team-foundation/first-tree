# `@first-tree/auto`

Local daemon that takes over your `gh` login and turns explicit GitHub review
requests and direct mentions into a triaged, optionally auto-handled inbox.
Drives a Claude Code statusline, an SSE dashboard, and scheduled background
work.

## What's In This Directory

```text
packages/auto/
├── VERSION
├── README.md              # this file
├── assets/
│   └── dashboard.html     # SSE dashboard served by the daemon HTTP server
├── src/
│   ├── cli.ts             # dispatcher (AUTO_USAGE + DISPATCH table + runAuto)
│   ├── bridge.ts          # package-root + spawn helpers
│   ├── statusline.ts      # zero-dep bundle source — see below
│   ├── commands/          # install, start, stop, poll, watch, doctor, cleanup, status, status-manager
│   ├── daemon/            # long-lived process: broker, bus, claim, dispatcher, http, poller, runner, scheduler, …
│   └── runtime/           # classifier, config, identity, paths, store, types, …
├── tests/                 # vitest suites mirroring src/
├── tsconfig.json
├── tsdown.config.ts       # bundles src/statusline.ts → dist/auto-statusline.js
└── vitest.config.ts
```

## Commands

### Primary

| Command | Role |
|---------|------|
| `first-tree auto install --allow-repo owner/repo` | Check `gh` / `jq` / auth, create `~/.first-tree/auto/config.yaml`, and start the daemon. Statusline hook wiring is a separate manual step. |
| `first-tree auto start --allow-repo owner/repo` | Launch the daemon in the background |
| `first-tree auto stop` | Stop the daemon and remove its lock |
| `first-tree auto status` | Print current daemon/runtime status |
| `first-tree auto doctor` | Diagnose daemon / gh login / runtime health |
| `first-tree auto watch` | Interactive TUI inbox (Ink) |
| `first-tree auto poll` | One-shot inbox poll without requiring the daemon |

### Advanced / internal

| Command | Role |
|---------|------|
| `first-tree auto run --allow-repo owner/repo` / `first-tree auto daemon --allow-repo owner/repo` | Run the broker loop in the foreground |
| `first-tree auto run-once --allow-repo owner/repo` | Run one poll cycle, wait for drain, then exit |
| `first-tree auto cleanup` | Clear stale state |
| `first-tree auto statusline` | CLI shim that executes the pre-bundled `dist/auto-statusline.js` hook |
| `first-tree auto status-manager` | Internal helper used by auto runners |
| `first-tree auto poll-inbox` | Legacy alias for `poll` |

Run `first-tree auto --help` for the authoritative list.

Daemon-starting commands (`install`, `start`, `run`, `daemon`, `run-once`)
must be given `--allow-repo <owner/repo[,owner/*,...]>` so auto never
falls back to scanning every notification on the account.

## Runtime Constraints

`src/statusline.ts` is bundled separately (`dist/auto-statusline.js`) and
is called every few seconds by the Claude Code statusline hook. It must stay
zero-dep and cold-start under 30ms — do not import `ink`, `zod`, or the
umbrella CLI from it.

## Related

- User-facing skill: [`skills/auto/SKILL.md`](./skills/auto/SKILL.md)
- Tests: [`tests/`](./tests)
