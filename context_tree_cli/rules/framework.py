"""Rule: check .context-tree/ framework presence."""

from __future__ import annotations

from context_tree_cli.repo import Repo

SEED_TREE_URL = "https://github.com/agent-team-foundation/seed-tree"


def evaluate(repo: Repo) -> dict:
    tasks = []
    if not repo.has_framework():
        tasks.append(
            f"`.context-tree/` not found — run `context-tree init` to clone the"
            f" framework from {SEED_TREE_URL}"
        )
    return {"group": "Framework", "order": 1, "tasks": tasks}
