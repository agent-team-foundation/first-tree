# Versioning

`first-tree` ships several things that are independently versioned on purpose.
This doc explains what each version means, when to bump which one, and why we
do not try to collapse them into a single SemVer stream.

## The Version Families

| Family | Files | Example | What it represents |
|--------|-------|---------|--------------------|
| **npm package** | `package.json#version` | `first-tree@0.2.6` | Released artifact. What `npm install -g first-tree` pins. |
| **Product** | `src/products/<name>/VERSION` | `tree=0.2.6`, `breeze=0.1.0`, `gardener=0.1.0` | The public surface of a single product CLI. |
| **Meta command** | `src/meta/skill-tools/VERSION` | `skill=0.2.6` | The public surface of the maintenance namespace. |
| **Skill payload** | `skills/<name>/VERSION` | `skills/tree/VERSION = 0.2` | The operational handbook an agent reads. |
| **Runtime asset** | `assets/<name>/VERSION` | `assets/tree/VERSION = 0.2.6` | Installed templates/workflows/helpers for user repos. |

## Why They Are Independent

Each family has a different audience and a different breaking-change trigger:

- **npm package** changes when we cut a release.
- **Product / meta command** changes when a single CLI surface changes.
- **Skill payload** changes when the agent-facing handbook changes.
- **Runtime asset** changes when the files we install into user repos change.

Collapsing these would either over-trigger upgrades or hide meaningful install
contract changes from `upgrade`.

## When To Bump What

| Change type | Bump |
|-------------|------|
| Release a new npm version | `package.json#version` |
| Add / change a `first-tree tree` subcommand | `src/products/tree/VERSION` |
| Add / change a `first-tree breeze` subcommand | `src/products/breeze/VERSION` |
| Add / change a `first-tree gardener` subcommand | `src/products/gardener/VERSION` |
| Change `first-tree skill install/upgrade/list/doctor/link` behavior | `src/meta/skill-tools/VERSION` |
| Edit `skills/first-tree/SKILL.md` or any shared reference | `skills/first-tree/VERSION` |
| Edit `skills/tree/SKILL.md` | `skills/tree/VERSION` |
| Edit a runtime template / workflow under `assets/tree/` | `assets/tree/VERSION` |

## How Versions Are Read

- `first-tree --version` iterates `ALL_COMMANDS` in
  [`src/products/manifest.ts`](../../src/products/manifest.ts) and prints one
  line per product/meta command via `readCommandVersion`.
- The umbrella CLI version comes from `package.json` via
  `readPackageVersion(import.meta.url, "first-tree")`.
- `readCommandVersion` delegates to [`src/shared/version.ts`](../../src/shared/version.ts)
  so built `dist/` entrypoints can still resolve shipped `VERSION` files.
- The installer reads `skills/<name>/VERSION` and `assets/<name>/VERSION` to
  decide whether to overwrite files during `first-tree tree init/upgrade`.

## Practical Rules

- Never bump a version “just to be consistent.” Each family changes on its own cadence.
- Bumping a skill `VERSION` without bumping its product `VERSION` is common.
- Bumping an asset `VERSION` without bumping a skill or product is also common.
- Namespace `VERSION` files must ship in the published package so built
  `dist/cli.js --version` does not print `unknown`.
