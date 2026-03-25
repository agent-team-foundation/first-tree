"""Rule: check agent configuration (Claude Code, Codex, etc.)."""

from __future__ import annotations

from context_tree_cli.repo import Repo


def evaluate(repo: Repo) -> dict:
    tasks = []
    if repo.path_exists(".claude/settings.json"):
        if not repo.file_contains(".claude/settings.json", "inject-tree-context"):
            tasks.append(
                "Add SessionStart hook to `.claude/settings.json`"
                " (see `.context-tree/examples/claude-code/`)"
            )
    elif not repo.any_agent_config():
        tasks.append(
            "No agent configuration detected. Configure your agent to load"
            " tree context at session start. See `.context-tree/examples/`"
            " for supported agents. You can skip this and set it up later."
        )
    return {"group": "Agent Integration", "order": 5, "tasks": tasks}
