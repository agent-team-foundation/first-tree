"""Rule: check members/ directory and member nodes."""

from __future__ import annotations

from context_tree_cli.repo import Repo


def evaluate(repo: Repo) -> dict:
    tasks = []
    if not repo.path_exists("members"):
        tasks.append("`members/` directory is missing — create it with a NODE.md")
    elif not repo.path_exists("members/NODE.md"):
        tasks.append("`members/NODE.md` is missing — create it from the template")
    if repo.has_members() and repo.member_count() == 0:
        tasks.append(
            "Add at least one member node for a team member or agent under `members/`"
        )
    elif not repo.has_members():
        tasks.append(
            "Add at least one member node for a team member or agent under `members/`"
        )
    return {"group": "Members", "order": 4, "tasks": tasks}
