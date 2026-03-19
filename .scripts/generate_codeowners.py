#!/usr/bin/env python3
"""Generate .github/CODEOWNERS from Context Tree ownership frontmatter.

Walks the tree, parses owners from NODE.md and leaf .md files, resolves
inheritance, and writes a CODEOWNERS file that GitHub can enforce.

Ownership rules (from first-tree/ownership-and-naming.md):
  1. NODE.md owners apply to all files in the folder.
  2. Leaf file owners are additive to NODE.md owners.
  3. Multiple owners allowed.
  4. Inheritance with override — owners: [] inherits from nearest parent
     NODE.md that declares owners. Explicit owners fully override the parent.
  5. Every folder requires a NODE.md.
  6. owners: [*] — anyone can approve; parent NODE.md owners still retain
     authority. In CODEOWNERS, we skip the specific entry so the folder rule
     (with parent owners) applies.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)
OWNERS_RE = re.compile(r"^owners:\s*\[([^\]]*)\]", re.MULTILINE)

TREE_ROOT = Path(__file__).resolve().parent.parent
CODEOWNERS_PATH = TREE_ROOT / ".github" / "CODEOWNERS"

# Files/dirs to skip when walking the tree.
SKIP = {".git", ".github", ".claude", ".idea", "scripts", "node_modules", "__pycache__"}


def parse_owners(path: Path) -> list[str] | None:
    """Extract owners list from frontmatter. Returns None if no frontmatter."""
    try:
        text = path.read_text()
    except OSError:
        return None
    fm = FRONTMATTER_RE.match(text)
    if not fm:
        return None
    m = OWNERS_RE.search(fm.group(1))
    if not m:
        return None
    raw = m.group(1).strip()
    if not raw:
        return []  # owners: [] — empty, will inherit
    return [o.strip() for o in raw.split(",") if o.strip()]


def resolve_node_owners(folder: Path, cache: dict[Path, list[str]]) -> list[str]:
    """Resolve effective owners for a folder's NODE.md, walking up for inheritance."""
    if folder in cache:
        return cache[folder]

    node_md = folder / "NODE.md"
    owners = parse_owners(node_md)

    if owners is None or owners == []:
        # Inherit from parent.
        parent = folder.parent
        if parent >= TREE_ROOT and parent != folder:
            resolved = resolve_node_owners(parent, cache)
        else:
            resolved = []
    else:
        resolved = owners

    cache[folder] = resolved
    return resolved


def is_wildcard(owners: list[str] | None) -> bool:
    return owners is not None and "*" in owners


def codeowners_path(path: Path) -> str:
    """Convert absolute path to CODEOWNERS-style repo-relative path."""
    rel = path.relative_to(TREE_ROOT)
    posix = rel.as_posix()
    if path.is_dir():
        return f"/{posix}/"
    return f"/{posix}"


def format_owners(owners: list[str]) -> str:
    """Format owners as @-prefixed GitHub handles, deduplicated."""
    seen: set[str] = set()
    result: list[str] = []
    for o in owners:
        if o not in seen:
            seen.add(o)
            result.append(f"@{o}")
    return " ".join(result)


def collect_entries(root: Path) -> list[tuple[str, list[str]]]:
    """Walk tree and collect (codeowners_pattern, owners) pairs."""
    node_cache: dict[Path, list[str]] = {}
    entries: list[tuple[str, list[str]]] = []

    for dirpath in sorted(root.rglob("*")):
        if not dirpath.is_dir():
            continue
        if any(part in SKIP for part in dirpath.relative_to(root).parts):
            continue
        node_md = dirpath / "NODE.md"
        if not node_md.exists():
            continue

        folder_owners = resolve_node_owners(dirpath, node_cache)

        # Folder-level entry. Skip wildcard folders — no CODEOWNERS entry
        # means no required reviewers, which is the intended behavior.
        if folder_owners and not is_wildcard(folder_owners):
            entries.append((codeowners_path(dirpath), folder_owners))

        # Leaf files in this folder.
        for child in sorted(dirpath.iterdir()):
            if not child.is_file() or child.suffix != ".md" or child.name == "NODE.md":
                continue
            leaf_owners = parse_owners(child)
            if is_wildcard(leaf_owners):
                # Wildcard — skip specific entry; folder rule applies.
                continue
            if leaf_owners:
                # Additive: folder owners + leaf owners (exclude wildcards).
                non_wildcard_folder = [o for o in folder_owners if o != "*"]
                combined = non_wildcard_folder + [o for o in leaf_owners if o not in non_wildcard_folder]
                if combined:
                    entries.append((codeowners_path(child), combined))
            # If leaf has no owners or owners: [], folder rule covers it — no entry needed.

    # Root-level leaf files (not in a subdomain folder).
    root_owners = resolve_node_owners(root, node_cache)
    for child in sorted(root.iterdir()):
        if not child.is_file() or child.suffix != ".md" or child.name == "NODE.md":
            continue
        leaf_owners = parse_owners(child)
        if is_wildcard(leaf_owners):
            continue
        if leaf_owners:
            combined = root_owners + [o for o in leaf_owners if o not in root_owners]
            entries.append((codeowners_path(child), combined))

    # Root entry (catch-all).
    if root_owners:
        entries.insert(0, ("/*", root_owners))

    return entries


def generate(check: bool = False) -> int:
    """Generate CODEOWNERS. If check=True, verify it's up-to-date instead."""
    entries = collect_entries(TREE_ROOT)

    lines = ["# Auto-generated from Context Tree. Do not edit manually.", ""]
    for pattern, owners in entries:
        if owners:
            lines.append(f"{pattern:<50} {format_owners(owners)}")
    lines.append("")  # trailing newline
    content = "\n".join(lines)

    if check:
        if CODEOWNERS_PATH.exists() and CODEOWNERS_PATH.read_text() == content:
            print("CODEOWNERS is up-to-date.")
            return 0
        else:
            print("CODEOWNERS is out-of-date. Run: python .scripts/generate_codeowners.py")
            return 1

    CODEOWNERS_PATH.parent.mkdir(parents=True, exist_ok=True)
    CODEOWNERS_PATH.write_text(content)
    print(f"Wrote {CODEOWNERS_PATH.relative_to(TREE_ROOT)}")
    return 0


if __name__ == "__main__":
    check = "--check" in sys.argv
    sys.exit(generate(check=check))
