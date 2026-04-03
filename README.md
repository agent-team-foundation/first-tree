# first-tree

Thin distribution package for the canonical `first-tree-cli-framework` skill
and the `context-tree` CLI.

## Quick Start

```bash
npx first-tree init
```

The npm package is `first-tree`; it installs the `context-tree` command. Use
`npm install -g first-tree` if you want the command on your PATH.
The package carries the canonical `first-tree-cli-framework` skill, and
`context-tree init` / `context-tree upgrade` install from that bundled skill.

## Commands

| Command | What it does |
| --- | --- |
| `context-tree init` | Bootstrap a new context tree in the current git repo |
| `context-tree verify` | Run verification checks against the current tree |
| `context-tree upgrade` | Refresh the installed framework skill from the current `first-tree` package and write follow-up tasks |
| `context-tree help onboarding` | Print the onboarding guide |

## Canonical Documentation

All framework documentation, maintainer guidance, and shipped runtime assets
live in `skills/first-tree-cli-framework/`.

- User-facing overview: `skills/first-tree-cli-framework/references/about.md`
- User onboarding: `skills/first-tree-cli-framework/references/onboarding.md`
- Maintainer entrypoint: `skills/first-tree-cli-framework/references/source-map.md`

If you are maintaining this repo, start with the source map instead of relying
on root-level prose.

## License

Apache 2.0
