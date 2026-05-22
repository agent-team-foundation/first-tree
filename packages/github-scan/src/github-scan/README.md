# `github-scan`

Internal implementation notes for `first-tree github scan`.

The public entrypoint is always the umbrella CLI:

```bash
first-tree github scan <command>
```

## What's In This Directory

```text
github-scan/
├── README.md              # product overview
├── cli.ts                 # dispatcher
├── version.ts             # runtime package version resolver
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
| `first-tree github scan install --allow-repo owner/repo` | Check `gh` / auth, create `~/.first-tree/github-scan/config.yaml`, and start the daemon. Statusline hook wiring is a separate manual step. |
| `first-tree github scan start --allow-repo owner/repo` | Launch the daemon in the background |
| `first-tree github scan stop` | Stop the daemon and remove its lock |
| `first-tree github scan status` | Print current daemon/runtime status |
| `first-tree github scan doctor` | Diagnose daemon / gh login / runtime health |
| `first-tree github scan watch` | Interactive TUI inbox (Ink) |
| `first-tree github scan poll [--allow-repo owner/repo]` | One-shot inbox poll without requiring the daemon |

### Advanced / internal

| Command | Role |
|---------|------|
| `first-tree github scan run --allow-repo owner/repo` / `first-tree github scan daemon --allow-repo owner/repo` | Run the broker loop in the foreground |
| `first-tree github scan run-once --allow-repo owner/repo` | Run one poll cycle, wait for drain, then exit |
| `first-tree github scan cleanup` | Clear stale state |
| `first-tree github scan statusline` | CLI shim that executes the pre-bundled `dist/github-scan-statusline.js` hook |
| `first-tree github scan status-manager` | Internal helper used by github-scan runners |
| `first-tree github scan poll-inbox` | Legacy alias for `poll` |

Run `first-tree github scan --help` for the authoritative list.

Daemon-starting commands (`install`, `start`, `run`, `daemon`, `run-once`)
must be given `--allow-repo <owner/repo[,owner/*,...]>` so github-scan never
falls back to scanning every notification on the account.

## Runtime Constraints

`engine/statusline.ts` is bundled separately (`dist/github-scan-statusline.js`) and
is called every few seconds by the Claude Code statusline hook. It must stay
zero-dep and cold-start under 30ms — do not import `ink`, `zod`, or the
umbrella CLI from it.

## Related

- Assets (SSE dashboard HTML): [`assets/dashboard.html`](../../../assets/dashboard.html)
- Tests: [`tests/github-scan/`](../../../tests/github-scan)
