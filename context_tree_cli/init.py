"""Init command: bootstrap a new context tree."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from context_tree_cli.repo import Repo
from context_tree_cli.rules import evaluate_all

SEED_TREE_URL = "https://github.com/agent-team-foundation/seed-tree"

FRAMEWORK_DIR = ".context-tree"

# Templates to render: (template file in .context-tree/templates/, target path in user repo)
TEMPLATE_MAP = [
    ("root-node.md.template", "NODE.md"),
    ("agent.md.template", "AGENT.md"),
    ("members-domain.md.template", "members/NODE.md"),
]



def _clone_seed_tree() -> Path:
    """Clone seed-tree to a temporary directory. Returns the temp dir path."""
    tmp = tempfile.mkdtemp(prefix="context-tree-")
    print(f"Cloning seed-tree from {SEED_TREE_URL}...")
    result = subprocess.run(
        ["git", "clone", "--depth", "1", SEED_TREE_URL, tmp],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"Failed to clone seed-tree: {result.stderr}", file=sys.stderr)
        shutil.rmtree(tmp, ignore_errors=True)
        sys.exit(1)
    return Path(tmp)


def _copy_framework(source: Path, target: Path) -> None:
    """Copy .context-tree/ from source to target."""
    src = source / FRAMEWORK_DIR
    dst = target / FRAMEWORK_DIR
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    print(f"  Copied {FRAMEWORK_DIR}/")


def _render_templates(framework_dir: Path, target: Path) -> None:
    """Copy templates from .context-tree/templates/ to their target paths."""
    templates_dir = framework_dir / "templates"
    for template_name, target_path in TEMPLATE_MAP:
        src = templates_dir / template_name
        dst = target / target_path
        if dst.exists():
            print(f"  Skipped {target_path} (already exists)")
        elif src.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            print(f"  Created {target_path}")




def _add_upstream_remote(target: Path) -> None:
    """Add seed-tree as context-tree-upstream remote if not already present."""
    result = subprocess.run(
        ["git", "remote"],
        cwd=target,
        capture_output=True,
        text=True,
    )
    if "context-tree-upstream" not in result.stdout.split():
        subprocess.run(
            ["git", "remote", "add", "context-tree-upstream", SEED_TREE_URL],
            cwd=target,
            capture_output=True,
        )
        print(f"  Added git remote 'context-tree-upstream' -> {SEED_TREE_URL}")


def _format_task_list(groups: list[dict]) -> str:
    """Format rule results as a grouped markdown checklist."""
    lines = ["# Context Tree Init\n"]
    for group in groups:
        lines.append(f"## {group['group']}")
        for task in group["tasks"]:
            lines.append(f"- [ ] {task}")
        lines.append("")
    lines.append("## Verification")
    lines.append(
        "After completing the tasks above, run `context-tree verify` to confirm:"
    )
    lines.append("- [ ] `.context-tree/VERSION` exists")
    lines.append("- [ ] Root NODE.md has valid frontmatter (title, owners)")
    lines.append("- [ ] AGENT.md exists with framework markers")
    lines.append("- [ ] `validate_nodes.py` passes with no errors")
    lines.append("- [ ] At least one member node exists")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append(
        "**Important:** As you complete each task, check it off in"
        " `.context-tree/progress.md` by changing `- [ ]` to `- [x]`."
        " Run `context-tree verify` when done — it will fail if any"
        " items remain unchecked."
    )
    lines.append("")
    return "\n".join(lines)


def _write_progress(repo: Repo, content: str) -> None:
    """Write the task list to .context-tree/progress.md."""
    progress_path = repo.root / ".context-tree" / "progress.md"
    progress_path.parent.mkdir(parents=True, exist_ok=True)
    progress_path.write_text(content)


def run_init() -> int:
    repo = Repo()

    if not repo.is_git_repo():
        print(
            "Error: not a git repository. Initialize one first:\n"
            "  git init",
            file=sys.stderr,
        )
        return 1

    # If framework is missing, clone seed-tree and copy files
    if not repo.has_framework():
        seed = _clone_seed_tree()
        try:
            print("Copying framework and scaffolding...")
            _copy_framework(seed, repo.root)
            framework_dir = repo.root / FRAMEWORK_DIR
            _render_templates(framework_dir, repo.root)
            _add_upstream_remote(repo.root)
        finally:
            shutil.rmtree(seed, ignore_errors=True)
        print()

    # Evaluate rules and generate task list
    groups = evaluate_all(repo)
    if not groups:
        print("All checks passed. Your context tree is set up.")
        return 0

    output = _format_task_list(groups)
    print(output)
    _write_progress(repo, output)
    print(f"Progress file written to .context-tree/progress.md")
    return 0
