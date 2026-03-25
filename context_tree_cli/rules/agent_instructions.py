"""Rule: check AGENT.md exists with framework markers."""

from __future__ import annotations

from context_tree_cli.repo import Repo


def evaluate(repo: Repo) -> dict:
    tasks = []
    if not repo.path_exists("AGENT.md"):
        tasks.append(
            "AGENT.md is missing — create from"
            " `.context-tree/templates/agent.md.template`"
        )
    elif not repo.has_agent_md_markers():
        tasks.append(
            "AGENT.md exists but is missing framework markers —"
            " add `<!-- BEGIN CONTEXT-TREE FRAMEWORK -->` and"
            " `<!-- END CONTEXT-TREE FRAMEWORK -->` sections"
        )
    else:
        # Check if user has added project-specific instructions
        text = repo.read_file("AGENT.md") or ""
        after_marker = text.split("<!-- END CONTEXT-TREE FRAMEWORK -->")
        if len(after_marker) > 1:
            user_section = after_marker[1].strip()
            # Remove the heading and comment
            lines = [
                l for l in user_section.splitlines()
                if l.strip()
                and not l.strip().startswith("#")
                and not l.strip().startswith("<!--")
            ]
            if not lines:
                tasks.append(
                    "Add your project-specific instructions below the"
                    " framework markers in AGENT.md"
                )
    return {"group": "Agent Instructions", "order": 3, "tasks": tasks}
