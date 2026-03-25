#!/usr/bin/env python3
"""Validate member nodes under members/ in the Context Tree.

Checks that every members/*/NODE.md has the required frontmatter fields:
  - title (non-empty string)
  - owners (valid list)
  - type (one of: human, personal_assistant, autonomous_agent)
  - role (non-empty string)
  - domains (non-empty list)
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

TREE_ROOT = Path(__file__).resolve().parent.parent
MEMBERS_DIR = TREE_ROOT / "members"

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)

VALID_TYPES = {"human", "personal_assistant", "autonomous_agent"}

# Simple YAML value extractors (no dependency on PyYAML).
# These work for the flat frontmatter format used in member nodes.


def rel(path: Path) -> str:
    return str(path.relative_to(TREE_ROOT))


def parse_frontmatter(path: Path) -> str | None:
    try:
        text = path.read_text()
    except OSError:
        return None
    m = FRONTMATTER_RE.match(text)
    return m.group(1) if m else None


def extract_scalar(fm: str, key: str) -> str | None:
    """Extract a scalar value like 'title: "Foo"' or 'role: Engineer'."""
    m = re.search(rf'^{key}:\s*"?([^"\n]+?)"?\s*$', fm, re.MULTILINE)
    return m.group(1).strip() if m else None


def extract_list(fm: str, key: str) -> list[str] | None:
    """Extract an inline list [a, b] or block list (- a\\n- b)."""
    # Inline: key: [a, b]
    m = re.search(rf"^{key}:\s*\[([^\]]*)\]", fm, re.MULTILINE)
    if m:
        raw = m.group(1).strip()
        if not raw:
            return []
        return [s.strip().strip('"').strip("'") for s in raw.split(",") if s.strip()]

    # Block: key:\n  - a\n  - b
    m = re.search(rf"^{key}:\s*\n((?:\s+-\s+.+\n?)+)", fm, re.MULTILINE)
    if m:
        lines = m.group(1).strip().splitlines()
        return [
            line.strip().removeprefix("- ").strip().strip('"').strip("'")
            for line in lines
            if line.strip()
        ]

    return None


def validate_member(node_path: Path) -> list[str]:
    """Validate a single member NODE.md. Returns list of error messages."""
    errors: list[str] = []
    loc = rel(node_path)

    fm = parse_frontmatter(node_path)
    if fm is None:
        return [f"{loc}: no frontmatter found"]

    # title
    title = extract_scalar(fm, "title")
    if not title:
        errors.append(f"{loc}: missing or empty 'title' field")

    # owners
    owners = extract_list(fm, "owners")
    if owners is None:
        errors.append(f"{loc}: missing 'owners' field")

    # type
    member_type = extract_scalar(fm, "type")
    if not member_type:
        errors.append(f"{loc}: missing 'type' field")
    elif member_type not in VALID_TYPES:
        errors.append(
            f"{loc}: invalid type '{member_type}' — "
            f"must be one of: {', '.join(sorted(VALID_TYPES))}"
        )

    # role
    role = extract_scalar(fm, "role")
    if not role:
        errors.append(f"{loc}: missing or empty 'role' field")

    # domains
    domains = extract_list(fm, "domains")
    if domains is None:
        errors.append(f"{loc}: missing 'domains' field")
    elif len(domains) == 0:
        errors.append(f"{loc}: 'domains' must contain at least one entry")

    return errors


def main() -> int:
    if not MEMBERS_DIR.is_dir():
        print(f"Members directory not found: {MEMBERS_DIR}")
        return 1

    all_errors: list[str] = []
    member_count = 0

    for child in sorted(MEMBERS_DIR.iterdir()):
        # Reject stray .md files directly under members/ (must use directory/NODE.md)
        if child.is_file() and child.suffix == ".md" and child.name != "NODE.md":
            all_errors.append(
                f"{rel(child)}: member must be a directory with NODE.md, "
                f"not a standalone file — use members/{child.stem}/NODE.md instead"
            )
            continue
        if not child.is_dir():
            continue
        node_path = child / "NODE.md"
        if not node_path.exists():
            all_errors.append(f"{rel(child)}/: directory exists but missing NODE.md")
            continue
        member_count += 1
        all_errors.extend(validate_member(node_path))

    if all_errors:
        print(f"Found {len(all_errors)} member validation error(s):\n")
        for err in all_errors:
            print(f"  \u2717 {err}")
        return 1

    print(f"All {member_count} member(s) passed validation.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
