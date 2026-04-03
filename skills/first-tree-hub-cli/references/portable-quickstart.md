# Portable Quickstart

This skill is meant to keep working even after the `skills/first-tree-hub-cli` folder is copied somewhere else.

## What Is Bundled

- the repo docs and CLI/package source files this skill depends on in `references/repo-snapshot/`
- helper scripts that either run a live local checkout or fall back to an installed `first-tree-hub` binary

Snapshot source:

- live repo: `agent-team-foundation/first-tree-hub`
- snapshot base commit when this portable copy was refreshed: `432b2e2becaf2dc8e80cbafef557731817fa059b`
- snapshot content fingerprint: `sha256:1a85e5e108642f5807fb3d3aa1c0a20cec32d762d6fd9ce9ba6df3d4593bed7a`

The base commit records which live checkout the refresh started from. Generated artifact updates may land in a later commit, so strict sync validation uses the content fingerprint above.

## If You Have A Live `first-tree-hub` Checkout

Run from the skill directory:

```bash
./scripts/run-local-cli.sh --help
./scripts/run-local-cli.sh --version
./scripts/run-local-cli.sh status
```

The script will detect the repo root, build the local CLI package, and run `node packages/command/dist/cli/index.mjs`.

## If You Only Copied This Skill Folder

Install or expose the CLI first. The npm package is `@agent-team-foundation/first-tree-hub`, and it installs the `first-tree-hub` command.

Practical options:

1. For one-off runs without installing anything globally, use the published package directly:

```bash
npx @agent-team-foundation/first-tree-hub --help
npx @agent-team-foundation/first-tree-hub status
```

2. To make this skill's helper script work outside the repo, install the package so `first-tree-hub` is on your `PATH`:

```bash
npm install -g @agent-team-foundation/first-tree-hub
first-tree-hub --help
first-tree-hub status
```

3. Clone `agent-team-foundation/first-tree-hub`, then from that repo run:

```bash
pnpm install
pnpm --filter @agent-team-foundation/first-tree-hub build
npm install -g ./packages/command
first-tree-hub --help
node packages/command/dist/cli/index.mjs --help
```

After that, this skill's helper script can use the installed binary:

```bash
./scripts/run-local-cli.sh --help
```

## Where To Read First

- `references/repo-snapshot/README.md`
- `references/repo-snapshot/AGENTS.md`
- `references/repo-snapshot/docs/cli-reference.md`
- `references/repo-snapshot/docs/onboarding-guide.md`
- `references/repo-snapshot/packages/command/src/core/onboard.ts`
- `references/repo-snapshot/packages/shared/src/config/server-config.ts`
