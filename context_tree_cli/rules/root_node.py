"""Rule: check root NODE.md exists and has valid frontmatter."""

from __future__ import annotations

from context_tree_cli.repo import Repo


def evaluate(repo: Repo) -> dict:
    tasks = []
    if not repo.path_exists("NODE.md"):
        tasks.append(
            "NODE.md is missing — create from"
            " `.context-tree/templates/root-node.md.template`,"
            " fill in your project's domains"
        )
    else:
        fm = repo.frontmatter("NODE.md")
        if fm is None:
            tasks.append(
                "NODE.md exists but has no frontmatter —"
                " add frontmatter with title and owners fields"
            )
        else:
            if not fm.get("title") or fm["title"].startswith("<"):
                tasks.append(
                    "NODE.md has a placeholder title — replace with your"
                    " organization name"
                )
            if not fm.get("owners") or (
                len(fm["owners"]) == 1 and fm["owners"][0].startswith("<")
            ):
                tasks.append(
                    "NODE.md has placeholder owners — set owners to your"
                    " GitHub username(s)"
                )
        if repo.has_placeholder_node():
            tasks.append(
                "NODE.md has placeholder content — fill in your project's"
                " domains and description"
            )
    return {"group": "Root Node", "order": 2, "tasks": tasks}
