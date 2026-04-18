# Claude Code Integration

## Setup

Copy `settings.json` to your tree repo's `.claude/` directory:

```bash
mkdir -p .claude
cp .claude/skills/first-tree/assets/framework/examples/claude-code/settings.json .claude/settings.json
```

## What It Does

The `SessionStart` hook runs `npx -p first-tree first-tree tree inject-context --skip-version-check` when a Claude Code session begins. This invokes the bundled CLI to read the root `NODE.md` and inject it as additional session context, giving the agent an overview of the tree structure before any task. The `--skip-version-check` flag avoids the npm registry check on every session start.
