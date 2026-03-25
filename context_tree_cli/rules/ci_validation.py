"""Rule: check CI/CD validation workflows."""

from __future__ import annotations

from context_tree_cli.repo import Repo


def evaluate(repo: Repo) -> dict:
    tasks = []
    has_validation = False
    workflows_dir = repo.root / ".github" / "workflows"
    if workflows_dir.is_dir():
        for wf in workflows_dir.iterdir():
            if wf.is_file() and wf.suffix in (".yml", ".yaml"):
                try:
                    content = wf.read_text()
                    if "validate_nodes" in content or "validate_members" in content:
                        has_validation = True
                        break
                except OSError:
                    continue
    if not has_validation:
        tasks.append(
            "No validation workflow found — copy"
            " `.context-tree/workflows/validate.yml` to"
            " `.github/workflows/validate.yml`"
        )
    return {"group": "CI / Validation", "order": 6, "tasks": tasks}
