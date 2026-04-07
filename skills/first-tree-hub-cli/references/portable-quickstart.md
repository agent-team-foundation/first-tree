# Portable Quickstart

This skill works both inside a live `first-tree-hub` checkout and as a standalone copy.

## If You Have A Live `first-tree-hub` Checkout

Run from the skill directory:

```bash
./scripts/run-local-cli.sh --help
./scripts/run-local-cli.sh --version
./scripts/run-local-cli.sh status
```

The script will detect the repo root, build the local CLI package, and run `node packages/command/dist/cli/index.mjs`.

## If You Only Copied This Skill Folder

Install the CLI first. The npm package is `@agent-team-foundation/first-tree-hub`, and it installs the `first-tree-hub` command.

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

- `SKILL.md` for the skill entry point and operating rules
- `references/command-surface.md` for CLI commands and environment variables
- `references/scenario-playbooks.md` for end-to-end operator flows
- `references/onboarding-operator.md` for automation-friendly onboarding
- `references/core-concepts.md` for product boundaries and architecture
- `references/developer-map.md` for source-file entry points and change workflows
