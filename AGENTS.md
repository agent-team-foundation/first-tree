# Repository Guidelines

## Project Structure & Module Organization

This repository is a small pnpm workspace for `first-tree`. The root
`package.json` holds workspace-level metadata and scripts, while
`pnpm-workspace.yaml` includes `apps/*` and `packages/*`. The CLI package lives
in `apps/cli/` and is published as `first-tree`. Put future shared libraries in
`packages/<name>/`. Keep package-specific source, tests, and assets inside the
owning package, for example `apps/cli/src/`, `apps/cli/tests/`, and
`apps/cli/assets/`.

## Build, Test, and Development Commands

- `pnpm install`: install workspace dependencies with the pinned pnpm version.
- `pnpm -r test`: run every package test script. Current test scripts are
  placeholders and fail until real tests are added.
- `pnpm --filter first-tree test`: run only the CLI package tests once
  implemented.
- Add package-level `build`, `typecheck`, and `lint` scripts before introducing
  compiled TypeScript or lint gates; expose root scripts through `pnpm -r`.

## Coding Style & Naming Conventions

Use English for code, comments, identifiers, commit messages, and technical
documentation. Prefer small modules with explicit exports. For JavaScript or
TypeScript, use 2-space indentation, `camelCase` for functions and variables,
`PascalCase` for classes and types, and `kebab-case` for command names,
workspace package names, and directories. Keep the root package thin; product
code should live in `apps/` or `packages/`.

## Testing Guidelines

No test framework is configured yet. When adding implementation, add tests in
the same workspace package and wire them through that package's `test` script.
Use `*.test.ts` or `*.test.js` naming, and prefer focused unit coverage for CLI
command parsing, filesystem behavior, and workspace validation. Add regression
tests with every bug fix.

## Commit & Pull Request Guidelines

Recent history is brief and includes `feat: init pnpm workspace`; prefer
Conventional Commits such as `feat: add cli entry`, `fix: handle missing config`,
or `docs: update contributor guide`. Keep subjects concise and imperative.

Pull requests should include a short problem statement, a summary of changes,
the commands run, and any known gaps. Link related issues when available. For
GitHub operations, prefer the `gh` CLI. Do not include generated artifacts,
local secrets, or unrelated formatting churn.
