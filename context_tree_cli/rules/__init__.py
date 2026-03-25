"""Rule loader for context-tree CLI."""

from __future__ import annotations

from context_tree_cli.repo import Repo
from context_tree_cli.rules import (
    agent_instructions,
    agent_integration,
    ci_validation,
    framework,
    members,
    root_node,
)

ALL_RULES = [
    framework,
    root_node,
    agent_instructions,
    members,
    agent_integration,
    ci_validation,
]


def evaluate_all(repo: Repo) -> list[dict]:
    """Run all rules and return sorted results, excluding groups with no tasks."""
    results = []
    for rule in ALL_RULES:
        result = rule.evaluate(repo)
        if result["tasks"]:
            results.append(result)
    return sorted(results, key=lambda r: r["order"])
