"""Verify command: run deterministic checks against the tree."""

from __future__ import annotations

import re
import subprocess
import sys

from context_tree_cli.repo import Repo

UNCHECKED_RE = re.compile(r"^- \[ \] (.+)$", re.MULTILINE)


def _check(label: str, passed: bool) -> bool:
    icon = "\u2713" if passed else "\u2717"
    status = "PASS" if passed else "FAIL"
    print(f"  {icon} [{status}] {label}")
    return passed


def _check_progress(repo: Repo) -> list[str]:
    """Read progress.md and return any unchecked items."""
    text = repo.read_file(".context-tree/progress.md")
    if text is None:
        return []
    return UNCHECKED_RE.findall(text)


def run_verify() -> int:
    repo = Repo()
    all_passed = True

    print("Context Tree Verification\n")

    # --- Progress file check ---
    unchecked = _check_progress(repo)
    if unchecked:
        print("  Unchecked items in .context-tree/progress.md:\n")
        for item in unchecked:
            print(f"    - [ ] {item}")
        print()
        print(
            "  Verify each step above and check it off in progress.md"
            " before running verify again.\n"
        )
        all_passed = False

    # --- Deterministic checks ---
    print("  Checks:\n")

    # 1. Framework exists
    all_passed &= _check(
        ".context-tree/VERSION exists",
        repo.has_framework(),
    )

    # 2. Root NODE.md has valid frontmatter
    fm = repo.frontmatter("NODE.md")
    has_valid_node = (
        fm is not None
        and "title" in fm
        and "owners" in fm
    )
    all_passed &= _check(
        "Root NODE.md has valid frontmatter (title, owners)",
        has_valid_node,
    )

    # 3. AGENT.md exists with framework markers
    all_passed &= _check(
        "AGENT.md exists with framework markers",
        repo.has_agent_md_markers(),
    )

    # 4. validate_nodes.py passes
    validate_script = repo.root / ".context-tree" / "validate_nodes.py"
    if validate_script.is_file():
        result = subprocess.run(
            [sys.executable, str(validate_script)],
            capture_output=True,
            text=True,
        )
        all_passed &= _check(
            "validate_nodes.py passes",
            result.returncode == 0,
        )
        if result.returncode != 0 and result.stdout:
            for line in result.stdout.strip().splitlines():
                print(f"    {line}")
    else:
        all_passed &= _check("validate_nodes.py exists", False)

    # 5. At least one member node exists
    all_passed &= _check(
        "At least one member node exists under members/",
        repo.member_count() > 0,
    )

    print()
    if all_passed:
        print("All checks passed.")
    else:
        print("Some checks failed. See above for details.")
    return 0 if all_passed else 1
