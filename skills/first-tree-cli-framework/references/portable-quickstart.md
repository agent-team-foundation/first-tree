# Portable Quickstart

This skill is meant to keep working even after the `skills/first-tree-cli-framework` folder is copied somewhere else.

## What Is Bundled

- a full snapshot of the current `first-tree/.context-tree/` directory in `references/repo-snapshot/.context-tree/`
- the repo docs and CLI source files this skill depends on
- helper scripts that either run a live local checkout or fall back to an installed `context-tree` binary

Snapshot source:

- live repo: `agent-team-foundation/first-tree`
- snapshot base commit when this portable copy was refreshed: `7f7567ef117edc1102800d8b0e9dff96aa11c524`
- snapshot content fingerprint: `sha256:5321c1ceb28664c9fcfa7d4b29c136734ac73fef9ed8cb6b19c79a70dd3d20f3`

The base commit records which live checkout the refresh started from. Generated artifact updates may land in a later commit, so strict sync validation uses the content fingerprint above.

## If You Have A Live `first-tree` Checkout

Run from the skill directory:

```bash
./scripts/run-local-cli.sh --help
./scripts/run-local-cli.sh --version
./scripts/run-local-cli.sh help onboarding
```

The script will detect the repo root, build the local CLI, and run `node dist/cli.js`.

## If You Only Copied This Skill Folder

Install or expose the CLI first. The npm package is `first-tree`, and it installs the `context-tree` command.

Practical options:

1. For one-off runs without installing anything globally, use the published package directly:

```bash
npx first-tree --help
npx first-tree help onboarding
```

2. To make this skill's helper script work outside the repo, install the package so `context-tree` is on your PATH:

```bash
npm install -g first-tree
context-tree --help
context-tree help onboarding
```

3. Clone `agent-team-foundation/first-tree`, then from that repo run:

```bash
pnpm install
pnpm build
npm install -g .
context-tree --help
node dist/cli.js --help
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
