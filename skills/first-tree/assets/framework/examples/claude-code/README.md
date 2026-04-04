# Claude Code Integration

## Setup

Copy `settings.json` to your tree repo's `.claude/` directory:

```bash
mkdir -p .claude
cp skills/first-tree/assets/framework/examples/claude-code/settings.json .claude/settings.json
```

## What It Does

The `SessionStart` hook runs `./skills/first-tree/assets/framework/helpers/inject-tree-context.sh` when a Claude Code session begins. This injects the root `NODE.md` content as additional context, giving the agent an overview of the tree structure before any task.
