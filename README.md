# first-tree

Template source and CLI for [Context Tree](https://context-tree.ai) — the living source of truth for your organization.

## What is Context Tree?

A tree-structured knowledge base that agents and humans build and maintain together. Every node represents a domain, decision, or design. Every node has an owner. When things change, the tree updates. See [about.md](skills/first-tree-cli-framework/references/about.md) for the full story.

## Quick Start

```bash
npx first-tree init
```

Run this inside a git repo. The npm package is `first-tree`; it installs the `context-tree` command. For a global install, run `npm install -g first-tree` and then use `context-tree init`.

## Commands

| Command | What it does |
|---------|-------------|
| `context-tree init` | Bootstrap a new context tree in the current git repo |
| `context-tree verify` | Run checks against the tree, report pass/fail |
| `context-tree upgrade` | Refresh the installed framework skill from upstream and generate follow-up tasks |

## What `init` creates

```
your-tree/
  skills/
    first-tree-cli-framework/
      progress.md
      references/
      assets/
        framework/
          VERSION
          templates/
          workflows/
          examples/
  NODE.md                  # root node — your domains (from template)
  AGENT.md                 # agent instructions with framework markers (from template)
  members/
    NODE.md                # members domain (from template)
```

## Upgrades

To upgrade the installed framework skill:

```bash
context-tree upgrade      # refreshes the installed skill and shows follow-up tasks
```

## Documentation

- [onboarding.md](skills/first-tree-cli-framework/references/onboarding.md) — Onboarding guide for setting up a context tree
- [about.md](skills/first-tree-cli-framework/references/about.md) — What Context Tree is and who it's for
- [principles.md](skills/first-tree-cli-framework/references/principles.md) — Core principles with examples
- [ownership-and-naming.md](skills/first-tree-cli-framework/references/ownership-and-naming.md) — Node naming and ownership model

## Development

```bash
pnpm install
pnpm test              # run tests
pnpm typecheck         # type check
pnpm build             # build CLI
```

## License

Apache 2.0
