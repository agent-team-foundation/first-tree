# Local development with isolation from prod

This repo's CLI is a long-running background service on the developer's
machine. Most of us already have a production `first-tree-hub` installed
globally (via `npm i -g @agent-team-foundation/first-tree-hub`), with a
running systemd unit / launchd plist keeping our personal agents online.
Naively running an in-tree dev build against the same machine would:

- overwrite `~/.first-tree/hub/credentials.json` with test credentials
- rewrite `~/.config/systemd/user/first-tree-hub-client.service` to point
  at the dev binary, killing the prod service and replacing it with the
  in-progress code
- leak crash-loop noise into the prod journald stream

The repo gives you two layered isolation knobs that compose:

| Knob | What it isolates | Set by |
|---|---|---|
| `FIRST_TREE_HUB_HOME` | config / credentials / workspaces / sessions / logs | already documented in `CLAUDE.md` |
| Home-derived service suffix | systemd unit name / launchd label / `SyslogIdentifier` | automatic — derived from the `FIRST_TREE_HUB_HOME` basename |

`scripts/dev-cli.sh` wires both together with a sensible default so you
don't have to remember either.

## Quickstart

```bash
# from repo root, first-time use
./scripts/dev-cli.sh --rebuild connect <connect-token>

# day-to-day
./scripts/dev-cli.sh client status
./scripts/dev-cli.sh client restart
./scripts/dev-cli.sh update --check
journalctl --user -u first-tree-hub-client-dev -f
```

After that, on Linux:

```bash
$ systemctl --user list-units 'first-tree-hub*'
  first-tree-hub-client.service       loaded active running    # prod, untouched
  first-tree-hub-client-dev.service   loaded active running    # dev, installed by dev-cli.sh
```

The two services have independent unit files, independent PIDs,
independent journald identifiers, and independent state under
`~/.first-tree/hub` (prod) vs `~/.first-tree/hub-dev` (dev).

## How the suffix is derived

The systemd unit name and launchd label come from the basename of
`FIRST_TREE_HUB_HOME` via `deriveServiceSuffix` in
[`packages/command/src/core/service-install.ts`](../packages/command/src/core/service-install.ts).
Rules:

| Home basename | systemd unit | launchd label |
|---|---|---|
| `hub` (default — what every prod machine in the field has) | `first-tree-hub-client.service` | `dev.first-tree-hub.client` |
| `hub-dev` (script default) | `first-tree-hub-client-dev.service` | `dev.first-tree-hub.client.dev` |
| `hub-test` | `first-tree-hub-client-test.service` | `dev.first-tree-hub.client.test` |
| `scratch` (anything not starting with `hub`) | `first-tree-hub-client-scratch.service` | `dev.first-tree-hub.client.scratch` |

The "`hub` → no suffix" rule is deliberate backwards-compatibility with
every machine that already has the prod unit registered. We never want
a CLI upgrade to silently rename people's prod service.

## When to use which knob

- **`scripts/dev-cli.sh` with default home** — most testing, including
  end-to-end `connect` / `client start` / `stop` / `restart` / `update`.
  Coexists with prod.
- **Custom dev home via `FIRST_TREE_HUB_DEV_HOME=$HOME/.first-tree/hub-foo`**
  — when you want a second parallel dev install (e.g. one per branch).
  Each home gets its own unit name automatically.
- **Direct `pnpm --filter ... dev`** — when iterating on code that does
  not touch service install, config, or credentials. `tsx` runs against
  source so `detectInstallMode()` returns `"source"` and any `update`
  path short-circuits — fine for everything except testing the
  install/restart side of `update` itself.
- **`./scripts/dev-cli.sh --rebuild`** — rebuilds dist before running.
  Use after editing any source under `packages/`.

## What `dev-cli.sh` does NOT isolate

- The PostgreSQL database. Hub server uses one shared DB by default.
  If you also run an in-tree server (`pnpm --filter @first-tree-hub/server dev`),
  use a separate DB URL via `FIRST_TREE_HUB_DATABASE_URL`.
- Global npm packages. `update --no-restart` will still run
  `npm install -g @agent-team-foundation/first-tree-hub@latest` and
  upgrade your machine-wide binary. Use `update --check` for safe
  read-only verification.
- Credentials shared with the Hub server (Hub-side rows in
  `clients` / `agents` tables). The dev install registers as a
  *separate* `clientId` because the home is different — server-side
  state stays clean.

## Tearing down a dev install

```bash
./scripts/dev-cli.sh client stop
# Optional — fully remove unit file + auto-start:
systemctl --user disable first-tree-hub-client-dev.service
rm ~/.config/systemd/user/first-tree-hub-client-dev.service
systemctl --user daemon-reload

# Wipe the isolated home if you want a fresh slate
rm -rf ~/.first-tree/hub-dev
```

Prod is unaffected throughout.
