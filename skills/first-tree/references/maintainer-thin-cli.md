# Thin CLI Shell

Use this reference when changing the root CLI/package shell.

## Shell Responsibilities

The root shell should do only a few things:

- parse commands and flags
- expose version/help
- load canonical framework behavior
- build, validate, and package the distributable

If a change requires non-trivial framework knowledge, put that knowledge in the
skill and have the shell call it.

## Shell Surface

These root files are shell code, not canonical knowledge stores:

- `src/cli.ts`
- `src/md.d.ts`
- `package.json`
- `tsconfig.json`
- `tsdown.config.ts`
- `vitest.config.ts`
- `vitest.eval.config.ts` (repo-only maintainer eval entrypoint)
- `.github/workflows/ci.yml`
- root `README.md` and `AGENTS.md`

## Rules For Shell Changes

- Keep root prose short. It should point to the skill, not duplicate the skill.
- Keep command semantics, install layout rules, and maintainer guidance in the
  skill references.
- If init/publish/upgrade semantics change for source/workspace repos versus dedicated
  tree repos, update `references/source-workspace-installation.md` and
  `references/upgrade-contract.md` instead of expanding root shell prose.
- If the shell gains behavior that is not obviously mechanical, move that
  behavior or its contract into the skill.
- When in doubt, prefer adding a skill reference over expanding root docs.
