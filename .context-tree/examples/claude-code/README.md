# Claude Code Integration

## Setup

Copy `settings.json` to your tree repo's `.claude/` directory:

```bash
mkdir -p .claude
cp .context-tree/examples/claude-code/settings.json .claude/settings.json
```

## What It Does

The `SessionStart` hook runs `.context-tree/scripts/inject-tree-context.sh` when a Claude Code session begins. This injects the root `NODE.md` content as additional context, giving the agent an overview of the tree structure before any task.

## Customization

You can add additional hooks alongside the framework hook. For example, to also inject custom instructions:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": ".context-tree/scripts/inject-tree-context.sh"
          }
        ]
      }
    ]
  }
}
```
