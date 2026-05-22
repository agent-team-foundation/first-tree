# Skill Topology

This document records the proposal-aligned skill shape for the restructured
`first-tree` CLI.

## Proposal Target

The proposal aims for this shipped skill layout:

```text
skills/
  first-tree/             whitepaper and routing entrypoint
  first-tree-onboarding/  setup flow for source/workspace roots
  first-tree-sync/        drift audit and repair workflow
  first-tree-write/       source-driven tree writing workflow
  first-tree-github-scan/ agent skill for a single GitHub notification
```

The intent is:

- `first-tree/` is the canonical whitepaper and routing layer
- the other four skills are task-specific workflows that reference the
  whitepaper rather than duplicating it
- old gardener logic belongs in `first-tree-sync` and `first-tree-write`
- no skill should reintroduce the old top-level `gardener` or `skill`
  CLI public shape
- operator handbooks can exist alongside the 5 workflow skills when they are
  tied to a runtime surface rather than a workflow topology

## Current Workspace Reality

This workspace now carries the canonical skill source at the repo root:

- `skills/first-tree/`
- `skills/first-tree-onboarding/`
- `skills/first-tree-sync/`
- `skills/first-tree-write/`
- `skills/first-tree-github-scan/`
- `skills/github-scan/` (auxiliary operational handbook for the daemon CLI)

The package-local `packages/github-scan/skills/github-scan/` copy remains so
the runtime package can publish its own handbook, but the repo-root and
package-local payloads now move together.

## Why This Matters

The CLI restructure is not just a command rename. It also changes how agents
discover and consume the product handbooks:

- `first-tree` becomes the whitepaper rather than an umbrella router
- `first-tree tree skill ...` becomes the maintenance namespace for shipped skills
- `github scan` now has a dedicated agent skill rather than inheriting the old
  `breeze` or `gardener` naming
- `github scan` routes notifications, but the old gardener business logic lives
  in `first-tree-sync` and `first-tree-write` instead of returning as a
  top-level product

## Contributor Guidance

When porting skill content back from the old main branch:

1. preserve the proposal's target names
2. keep the whitepaper content centralized in `skills/first-tree/references/`
3. avoid reintroducing the old top-level `skill` or `gardener` CLI public shape
4. update both the docs and install/upgrade flows together
