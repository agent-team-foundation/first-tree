# seed-tree

Template source and CLI for [Context Tree](https://context-tree.ai) — the living source of truth for your organization.

## What is Context Tree?

A tree-structured knowledge base that agents and humans build and maintain together. Every node represents a domain, decision, or design. Every node has an owner. When things change, the tree updates. See [docs/about.md](docs/about.md) for the full story.

## Quick Start

```bash
npx context-tree init
```

Run this inside a git repo. It clones the framework, renders scaffolding, and generates a task list for your agent to work through.

## Commands

| Command | What it does |
|---------|-------------|
| `context-tree init` | Bootstrap a new context tree in the current git repo |
| `context-tree verify` | Run checks against the tree, report pass/fail |
| `context-tree upgrade` | Compare local framework version to upstream, generate upgrade tasks |

## What `init` creates

```
your-tree/
  .context-tree/           # framework (upgradable from seed-tree)
    VERSION
    principles.md
    ownership-and-naming.md
    templates/
    workflows/
    examples/
  NODE.md                  # root node — your domains (from template)
  AGENT.md                 # agent instructions with framework markers (from template)
  members/
    NODE.md                # members domain (from template)
```

## Upgrades

After init, seed-tree is added as a git remote (`context-tree-upstream`). To upgrade the framework:

```bash
context-tree upgrade      # shows what changed and what to do
```

## Documentation

- [docs/onboarding.md](docs/onboarding.md) — Onboarding guide for setting up a context tree (for agents)
- [docs/about.md](docs/about.md) — What is Context Tree and who it's for
- [.context-tree/principles.md](.context-tree/principles.md) — Core principles with examples
- [.context-tree/ownership-and-naming.md](.context-tree/ownership-and-naming.md) — Node naming and ownership model

## Development

```bash
pnpm install
pnpm test              # run tests
pnpm typecheck         # type check
pnpm build             # build CLI
```

## License

Apache 2.0
