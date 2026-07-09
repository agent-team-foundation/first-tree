# Local development with isolation from prod / staging

This repo's CLI is a long-running background service on the developer's
machine. Most of us run prod (`first-tree`) or staging
(`first-tree-staging`) somewhere — installed globally via npm and kept
alive by systemd / launchd / Task Scheduler. The in-tree dev build must
coexist with both without touching their state.

The multi-env split (see [`MIGRATION.md`](../../MIGRATION.md) Phase 2)
makes this trivial: every channel has its own bin name, default home,
and supervisor identifier. Running `scripts/dev-install.sh` installs the dev
channel (`first-tree-dev` / `~/.first-tree-dev/` /
`first-tree-dev.service`, or the Windows Task Scheduler task
`\FirstTree\first-tree-dev`) alongside whatever prod / staging install you
already have.

| Channel | Install via | Bin | Default home | Supervisor identifier |
|---|---|---|---|---|
| dev | `scripts/dev-install.sh` (in-tree, symlinked) | `first-tree-dev` / `ftd` | `~/.first-tree-dev/` | `first-tree-dev.service` / `\FirstTree\first-tree-dev` |
| staging | `npm i -g first-tree-staging` | `first-tree-staging` / `fts` | `~/.first-tree-staging/` | `first-tree-staging.service` / `\FirstTree\first-tree-staging` |
| prod | `npm i -g first-tree` | `first-tree` / `ft` | `~/.first-tree/` | `first-tree.service` / `\FirstTree\first-tree` |

Each install registers as a separate `clientId` on whichever server it
connects to (dev → local server, staging → `dev.cloud.first-tree.ai`,
prod → `cloud.first-tree.ai`), so server-side state stays cleanly
partitioned too.

## Quickstart

```bash
# from repo root, first-time use
./scripts/dev-install.sh

# Start your local server (any way you like — e.g. `pnpm --filter @first-tree/server dev`)

first-tree-dev login <connect-code>    # code from http://127.0.0.1:8000/clients
first-tree-dev daemon status
journalctl --user -u first-tree-dev -f
```

After editing any source file, re-run `./scripts/dev-install.sh`; it
rebuilds dist and restarts the installed dev daemon so the running
service picks up the new build:

```bash
./scripts/dev-install.sh
```

After login, on Linux:

```bash
$ systemctl --user list-units 'first-tree*'
  first-tree.service             loaded active running    # prod (if installed), untouched
  first-tree-staging.service     loaded active running    # staging (if installed), untouched
  first-tree-dev.service         loaded active running    # dev, installed by dev-install.sh
```

Three independent unit files, three PIDs, three journald identifiers,
three home dirs. No cross-contamination.

## How channel identity is wired

`apps/cli/src/build-info.ts` exports a single `CHANNEL` constant
(`"dev"` in source, rewritten to `"prod"` / `"staging"` by CI before
publish). All downstream identifiers — npm package name, bin name,
default home, default server URL, service unit, launchd label — derive
from this single value via `getChannelConfig` in
[`packages/shared/src/channel/`](../../packages/shared/src/channel/index.ts).

`apps/cli/src/core/channel-env.ts` runs as the very first import in the
CLI entry. It sets `process.env.FIRST_TREE_HOME` from the channel's
default home (unless the operator already set the env explicitly),
which the `@first-tree/shared/config` module then reads at load time.
That's how every const-import of `DEFAULT_HOME_DIR` automatically picks
up the right channel-aware path with zero refactoring at call sites.

The published-package `name` and `bin` get rewritten by the CI publish
job alongside `CHANNEL` — the source-tree `apps/cli/package.json`
always carries the dev shape (`name: "first-tree-dev"`, bin
`first-tree-dev` / `ftd`).

## Auto-update across channels

`UpdateManager` keeps polling the server for a target version. The
client-side guard in
[`apps/cli/src/core/update.ts`](../../apps/cli/src/core/update.ts) refuses
to install a version whose channel does not match this binary's
channel — `inferChannelFromVersion("0.5.2-staging.42.1") === "staging"`,
so a prod CLI told to install that target logs an error and skips.
Dev binaries refuse self-update entirely (`packageName === null`).

If you need to swap dev for staging without `git pull`, install staging
side-by-side:

```bash
npm i -g first-tree-staging
first-tree-staging login <staging-token>
# now both `first-tree-dev daemon status` and `first-tree-staging daemon status` work
```

## When to use which install

- **`scripts/dev-install.sh`** — actively iterating on CLI / client /
  shared code. Build is local, no server or npm upgrade round-trip.
  `upgrade` short-circuits because `detectInstallMode()` returns
  `"source"`.
- **Direct `pnpm --filter ... dev`** — running parts of the system in
  isolation (server-only, web-only) where you don't need the full CLI
  surface. `tsx` runs against source.
- **`npm i -g first-tree-staging`** — when you want to test against the
  exact bits that team members run. Coexists with dev install; data
  stays in `~/.first-tree-staging/`.

## What `dev-install.sh` does NOT isolate

- The PostgreSQL database. The server uses one shared DB by default. If
  you also run an in-tree server (`pnpm --filter @first-tree/server dev`),
  use a separate DB URL via `FIRST_TREE_DATABASE_URL`.
- Global npm packages. If you have both staging and prod installed,
  upgrading either (e.g. via `first-tree-staging upgrade`) follows that
  channel's configured server target and affects your machine-wide install.
  `--latest` bypasses the server and goes directly to npm. Dev is immune
  because its source-checkout install mode short-circuits the upgrade path.

## Tearing down a dev install

```bash
first-tree-dev daemon stop
# Optional — fully remove the unit file + auto-start:
systemctl --user disable first-tree-dev.service
rm ~/.config/systemd/user/first-tree-dev.service
systemctl --user daemon-reload

# Remove the bin symlinks
rm ~/.local/bin/first-tree-dev ~/.local/bin/ftd

# Wipe the isolated home if you want a fresh slate
rm -rf ~/.first-tree-dev
```

Prod / staging installs are unaffected throughout.

## Migrating from the pre-multi-env layout

If you ran `scripts/dev-cli.sh` before this PR, your dev data lives at
`~/.first-tree/hub-dev/`. `scripts/dev-install.sh` auto-`mv`s it to
`~/.first-tree-dev/` on first run — no manual step required.

Prod / staging migration (replacing the old single-package install) is
documented in [`MIGRATION.md`](../../MIGRATION.md) Phase 2.
