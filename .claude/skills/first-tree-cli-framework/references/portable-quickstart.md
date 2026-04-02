# Portable Quickstart

This skill is meant to keep working even after the `skills/first-tree-cli-framework` folder is copied somewhere else.

## What Is Bundled

- a full snapshot of the current `first-tree/.context-tree/` directory in `references/repo-snapshot/.context-tree/`
- the repo docs and CLI source files this skill depends on
- helper scripts that either run a live local checkout or fall back to an installed `context-tree` binary

Snapshot source:

- live repo: `agent-team-foundation/first-tree`
- snapshot base commit when this portable copy was refreshed: `50f157ac815ab1d1cd94eddb113ea7b0b3ae1df9`

## If You Have A Live `first-tree` Checkout

Run from the skill directory:

```bash
./scripts/run-local-cli.sh --help
./scripts/run-local-cli.sh --version
./scripts/run-local-cli.sh help onboarding
```

The script will detect the repo root, build the local CLI, and run `node dist/cli.js`.

## If You Only Copied This Skill Folder

Install or expose a `context-tree` binary first.

Practical options:

1. Clone `agent-team-foundation/first-tree`, then from that repo run:

```bash
pnpm install
pnpm build
node dist/cli.js --help
```

If you want the `context-tree` command on your PATH, use your preferred link/install workflow after building.

2. If your environment already has a `context-tree` binary installed, run:

```bash
context-tree --help
context-tree help onboarding
```

After that, this skill's helper script can use the installed binary:

```bash
./scripts/run-local-cli.sh --help
```

## Where To Read First

- `references/repo-snapshot/README.md`
- `references/repo-snapshot/AGENTS.md`
- `references/repo-snapshot/docs/onboarding.md`
- `references/repo-snapshot/.context-tree/principles.md`
- `references/repo-snapshot/.context-tree/ownership-and-naming.md`
