#!/usr/bin/env python3
"""Validate .md node files in the Context Tree.

Checks:
  1. owners — must be present in frontmatter and syntactically valid.
  2. soft_links — if present, each target must resolve to an existing node.
  3. folder structure — every non-skipped folder must contain a NODE.md.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

TREE_ROOT = Path(__file__).resolve().parent.parent

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)
OWNERS_RE = re.compile(r"^owners:\s*\[([^\]]*)\]", re.MULTILINE)
# Matches both inline and multi-line soft_links lists.
SOFT_LINKS_INLINE_RE = re.compile(r"^soft_links:\s*\[([^\]]*)\]", re.MULTILINE)
SOFT_LINKS_BLOCK_RE = re.compile(
    r"^soft_links:\s*\n((?:\s+-\s+.+\n?)+)", re.MULTILINE
)

SKIP = {"node_modules", "__pycache__"}

# Non-node .md files at repo root (infrastructure, not tree nodes).
SKIP_FILES = {"AGENT.md", "CLAUDE.md"}

# GitHub username: alphanumeric and hyphens, 1-39 chars, no leading/trailing hyphen.
GITHUB_USER_RE = re.compile(r"^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$")


def rel(path: Path) -> str:
    return str(path.relative_to(TREE_ROOT))


def parse_frontmatter(path: Path) -> str | None:
    """Return raw frontmatter string or None."""
    try:
        text = path.read_text()
    except OSError:
        return None
    m = FRONTMATTER_RE.match(text)
    return m.group(1) if m else None


def validate_owners(fm: str, path: Path) -> list[str]:
    """Validate owners field. Returns list of error messages."""
    m = OWNERS_RE.search(fm)
    if not m:
        return [f"{rel(path)}: missing 'owners' field in frontmatter"]

    raw = m.group(1).strip()
    if not raw:
        return []  # owners: [] is valid (inheritance)

    owners = [o.strip() for o in raw.split(",") if o.strip()]
    if not owners:
        return [f"{rel(path)}: owners list contains only whitespace entries"]

    # owners: [*] is valid
    if owners == ["*"]:
        return []

    errors = []
    for owner in owners:
        if owner == "*":
            errors.append(
                f"{rel(path)}: wildcard '*' must be the sole entry, not mixed with usernames"
            )
        elif not GITHUB_USER_RE.match(owner):
            errors.append(f"{rel(path)}: invalid owner '{owner}'")
    return errors


def parse_soft_links(fm: str) -> list[str] | None:
    """Extract soft_links from frontmatter. Returns None if not present."""
    # Try inline format first: soft_links: [/a, /b]
    m = SOFT_LINKS_INLINE_RE.search(fm)
    if m:
        raw = m.group(1).strip()
        if not raw:
            return []
        return [s.strip().strip('"').strip("'") for s in raw.split(",") if s.strip()]

    # Try block format: soft_links:\n  - /a\n  - /b
    m = SOFT_LINKS_BLOCK_RE.search(fm)
    if m:
        lines = m.group(1).strip().splitlines()
        return [line.strip().removeprefix("- ").strip().strip('"').strip("'") for line in lines]

    return None


def resolve_soft_link(link: str) -> bool:
    """Check if a soft_link target resolves to a valid node."""
    # Normalize: strip leading /
    clean = link.lstrip("/")
    target = TREE_ROOT / clean

    # Could be a direct .md file
    if target.is_file() and target.suffix == ".md":
        return True

    # Could be a directory (should have NODE.md)
    if target.is_dir() and (target / "NODE.md").exists():
        return True

    # Could be a path without extension that maps to a directory
    if not target.suffix and target.is_dir():
        return (target / "NODE.md").exists()

    return False


def validate_soft_links(fm: str, path: Path) -> list[str]:
    """Validate soft_links if present. Returns list of error messages."""
    links = parse_soft_links(fm)
    if links is None:
        return []

    errors = []
    for link in links:
        if not link:
            errors.append(f"{rel(path)}: empty soft_link entry")
        elif not resolve_soft_link(link):
            errors.append(f"{rel(path)}: soft_link '{link}' does not resolve to an existing node")
    return errors


def validate_folders() -> list[str]:
    """Check that every non-skipped folder contains a NODE.md."""
    errors = []
    for dirpath in sorted(TREE_ROOT.rglob("*")):
        if not dirpath.is_dir():
            continue
        parts = dirpath.relative_to(TREE_ROOT).parts
        if any(part in SKIP or part.startswith(".") for part in parts):
            continue
        if not (dirpath / "NODE.md").exists():
            errors.append(f"{rel(dirpath)}/: missing NODE.md")
    return errors


def collect_md_files() -> list[Path]:
    """Collect all .md files in the tree (excluding skipped dirs)."""
    files = []
    for path in sorted(TREE_ROOT.rglob("*.md")):
        parts = path.relative_to(TREE_ROOT).parts
        if any(part in SKIP or part.startswith(".") for part in parts):
            continue
        # Skip symlinks and known non-node files
        if path.is_symlink():
            continue
        if path.name in SKIP_FILES:
            continue
        files.append(path)
    return files


def main() -> int:
    files = collect_md_files()
    all_errors: list[str] = []

    all_errors.extend(validate_folders())

    for path in files:
        fm = parse_frontmatter(path)
        if fm is None:
            all_errors.append(f"{rel(path)}: no frontmatter found")
            continue

        all_errors.extend(validate_owners(fm, path))
        all_errors.extend(validate_soft_links(fm, path))

    if all_errors:
        print(f"Found {len(all_errors)} validation error(s):\n")
        for err in all_errors:
            print(f"  ✗ {err}")
        return 1

    print(f"All {len(files)} node(s) passed validation.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
