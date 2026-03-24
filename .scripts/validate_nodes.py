#!/usr/bin/env python3
"""Validate .md node files in the Context Tree.

Checks:
  1. owners [error] — must be present in frontmatter and syntactically valid.
  2. soft_links [error] — if present, each target must resolve to an existing node.
  3. folder structure [error] — every non-skipped folder must contain a NODE.md.
  4. directory-listing [warning] — NODE.md body must reference all leaf files in its folder.
  5. root-domain-sync [error] — root NODE.md domain list must match actual directories.
  6. soft-link-reciprocity [info] — flag one-way soft_links.
  7. empty-nodes [warning] — flag nodes with no meaningful body content.
  8. title-mismatch [warning] — frontmatter title must match first heading.

Exit code: 1 if any errors; 0 if only warnings/infos.
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
TITLE_RE = re.compile(r'^title:\s*["\']?(.+?)["\']?\s*$', re.MULTILINE)

SKIP = {"node_modules", "__pycache__"}

# Non-node .md files at repo root (infrastructure, not tree nodes).
SKIP_FILES = {"AGENT.md", "CLAUDE.md"}

# GitHub username: alphanumeric and hyphens, 1-39 chars, no leading/trailing hyphen.
GITHUB_USER_RE = re.compile(r"^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$")

# Markdown link patterns to detect .md file references in NODE.md body.
# Matches [text](file.md) and [text](dir/file.md) style links.
MD_LINK_RE = re.compile(r"\[.*?\]\(([^)]+\.md)\)")
DOMAIN_LINK_RE = re.compile(r"\[(\w[\w-]*)/?]\((\w[\w-]*)/NODE\.md\)")

MIN_BODY_LENGTH = 20


# ---------------------------------------------------------------------------
# Severity helpers
# ---------------------------------------------------------------------------

class Findings:
    """Collects findings at three severity levels."""

    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.infos: list[str] = []

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def warning(self, msg: str) -> None:
        self.warnings.append(msg)

    def info(self, msg: str) -> None:
        self.infos.append(msg)

    def has_errors(self) -> bool:
        return bool(self.errors)

    def print_report(self, total_files: int) -> None:
        all_items = (
            [("error", e) for e in self.errors]
            + [("warning", w) for w in self.warnings]
            + [("info", i) for i in self.infos]
        )
        if all_items:
            counts = []
            if self.errors:
                counts.append(f"{len(self.errors)} error(s)")
            if self.warnings:
                counts.append(f"{len(self.warnings)} warning(s)")
            if self.infos:
                counts.append(f"{len(self.infos)} info(s)")
            print(f"Found {', '.join(counts)}:\n")
            for severity, msg in all_items:
                icon = {"error": "\u2717", "warning": "\u26a0", "info": "\u2139"}[severity]
                print(f"  {icon} [{severity}] {msg}")
        else:
            print(f"All {total_files} node(s) passed validation.")


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def rel(path: Path) -> str:
    return str(path.relative_to(TREE_ROOT))


def _should_skip(path: Path) -> bool:
    """Return True if path is in a skipped or dot-prefixed directory."""
    parts = path.relative_to(TREE_ROOT).parts
    return any(part in SKIP or part.startswith(".") for part in parts)


_text_cache: dict[Path, str | None] = {}


def read_text(path: Path) -> str | None:
    if path not in _text_cache:
        try:
            _text_cache[path] = path.read_text()
        except OSError:
            _text_cache[path] = None
    return _text_cache[path]


def parse_frontmatter(path: Path) -> str | None:
    """Return raw frontmatter string or None."""
    text = read_text(path)
    if text is None:
        return None
    m = FRONTMATTER_RE.match(text)
    return m.group(1) if m else None


def parse_body(path: Path) -> str | None:
    """Return body text (everything after frontmatter) or None."""
    text = read_text(path)
    if text is None:
        return None
    m = FRONTMATTER_RE.match(text)
    if m:
        return text[m.end():]
    return text


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


def collect_md_files() -> list[Path]:
    """Collect all .md files in the tree (excluding skipped dirs)."""
    files = []
    for path in sorted(TREE_ROOT.rglob("*.md")):
        if _should_skip(path):
            continue
        if path.is_symlink():
            continue
        if path.name in SKIP_FILES:
            continue
        files.append(path)
    return files


def normalize_soft_link(link: str) -> Path:
    """Normalize a soft_link string to an absolute path for comparison."""
    clean = link.lstrip("/")
    target = TREE_ROOT / clean
    if target.is_dir():
        return target / "NODE.md"
    return target


# ---------------------------------------------------------------------------
# Original checks
# ---------------------------------------------------------------------------

def validate_owners(fm: str, path: Path, findings: Findings) -> None:
    """Validate owners field."""
    m = OWNERS_RE.search(fm)
    if not m:
        findings.error(f"{rel(path)}: missing 'owners' field in frontmatter")
        return

    raw = m.group(1).strip()
    if not raw:
        return  # owners: [] is valid (inheritance)

    owners = [o.strip() for o in raw.split(",") if o.strip()]
    if not owners:
        findings.error(f"{rel(path)}: owners list contains only whitespace entries")
        return

    # owners: [*] is valid
    if owners == ["*"]:
        return

    for owner in owners:
        if owner == "*":
            findings.error(
                f"{rel(path)}: wildcard '*' must be the sole entry, not mixed with usernames"
            )
        elif not GITHUB_USER_RE.match(owner):
            findings.error(f"{rel(path)}: invalid owner '{owner}'")


def validate_soft_links(fm: str, path: Path, findings: Findings) -> None:
    """Validate soft_links if present."""
    links = parse_soft_links(fm)
    if links is None:
        return

    for link in links:
        if not link:
            findings.error(f"{rel(path)}: empty soft_link entry")
        elif not resolve_soft_link(link):
            findings.error(f"{rel(path)}: soft_link '{link}' does not resolve to an existing node")


def validate_folders(findings: Findings) -> None:
    """Check that every non-skipped folder contains a NODE.md."""
    for dirpath in sorted(TREE_ROOT.rglob("*")):
        if not dirpath.is_dir():
            continue
        if _should_skip(dirpath):
            continue
        if not (dirpath / "NODE.md").exists():
            findings.error(f"{rel(dirpath)}/: missing NODE.md")


# ---------------------------------------------------------------------------
# New checks (tree-inspection proposal)
# ---------------------------------------------------------------------------

def validate_directory_listing(findings: Findings) -> None:
    """Check that each NODE.md references all leaf .md files in its directory.

    Flags:
      - orphan: a .md file exists on disk but is not mentioned in NODE.md body
      - phantom: NODE.md mentions a .md file that doesn't exist on disk
    """
    for dirpath in sorted(TREE_ROOT.rglob("*")):
        if not dirpath.is_dir():
            continue
        if _should_skip(dirpath):
            continue

        node_md = dirpath / "NODE.md"
        if not node_md.exists():
            continue

        body = parse_body(node_md)
        if body is None:
            continue

        actual_leaves = {
            f.name
            for f in dirpath.iterdir()
            if f.is_file() and f.suffix == ".md" and f.name != "NODE.md"
        }

        referenced = set()
        for match in MD_LINK_RE.finditer(body):
            ref = match.group(1)
            if ref.startswith("http") or ref.startswith("/"):
                continue
            # Handle links like "subdir/NODE.md" — only care about same-dir leaves.
            if "/" not in ref:
                referenced.add(ref)

        for orphan in sorted(actual_leaves - referenced):
            findings.warning(
                f"{rel(node_md)}: leaf file '{orphan}' exists but is not mentioned in NODE.md"
            )

        for ref in sorted(referenced - actual_leaves):
            candidate = dirpath / ref
            if not candidate.exists():
                findings.warning(
                    f"{rel(node_md)}: references '{ref}' but the file does not exist"
                )


def validate_root_domain_sync(findings: Findings) -> None:
    """Check that root NODE.md's domain list matches actual top-level directories."""
    node_md = TREE_ROOT / "NODE.md"
    body = parse_body(node_md)
    if body is None:
        return

    listed_domains = set()
    for m in DOMAIN_LINK_RE.finditer(body):
        listed_domains.add(m.group(2))

    actual_domains = set()
    for child in sorted(TREE_ROOT.iterdir()):
        if not child.is_dir():
            continue
        name = child.name
        if name.startswith(".") or name in SKIP:
            continue
        if (child / "NODE.md").exists():
            actual_domains.add(name)

    for missing in sorted(actual_domains - listed_domains):
        findings.error(
            f"NODE.md: domain directory '{missing}/' exists but is not listed in root NODE.md"
        )

    for extra in sorted(listed_domains - actual_domains):
        findings.error(
            f"NODE.md: lists domain '{extra}/' but the directory does not exist or has no NODE.md"
        )


def validate_soft_link_reciprocity(files: list[Path], findings: Findings) -> None:
    """Flag one-way soft_links: A links to B but B has no reference back to A.

    Checks both frontmatter soft_links and body text mentions.
    """
    all_links: list[tuple[Path, Path]] = []

    for path in files:
        fm = parse_frontmatter(path)
        if fm is None:
            continue
        links = parse_soft_links(fm)
        if not links:
            continue
        for link in links:
            if not link:
                continue
            target = normalize_soft_link(link)
            all_links.append((path, target))

    for source, target in all_links:
        if not target.exists():
            continue  # Already caught by validate_soft_links.

        target_fm = parse_frontmatter(target)
        has_back_link = False

        if target_fm:
            target_links = parse_soft_links(target_fm)
            if target_links:
                for tl in target_links:
                    if not tl:
                        continue
                    resolved = normalize_soft_link(tl)
                    if resolved == source or resolved == source.parent / "NODE.md":
                        has_back_link = True
                        break

        if not has_back_link:
            target_body = parse_body(target)
            if target_body:
                source_rel = rel(source)
                # Check for explicit markdown link back to source file or directory
                for match in MD_LINK_RE.finditer(target_body):
                    ref = match.group(1)
                    if ref.startswith("http") or ref.startswith("/"):
                        continue
                    if source_rel.endswith(ref) or ref == source_rel:
                        has_back_link = True
                        break

        if not has_back_link:
            findings.info(
                f"{rel(source)}: soft_link to '{rel(target)}' is one-way "
                f"(target has no reference back)"
            )


def validate_empty_nodes(files: list[Path], findings: Findings) -> None:
    """Flag .md files with frontmatter but no meaningful body content."""
    for path in files:
        text = read_text(path)
        if text is None:
            continue
        m = FRONTMATTER_RE.match(text)
        if not m:
            continue
        body = text[m.end():]
        stripped = re.sub(r"\s+", "", body)
        if len(stripped) < MIN_BODY_LENGTH:
            findings.warning(f"{rel(path)}: node has little or no body content")


def validate_title_mismatch(files: list[Path], findings: Findings) -> None:
    """Check that frontmatter title matches the first # heading in the body."""
    for path in files:
        text = read_text(path)
        if text is None:
            continue
        fm_match = FRONTMATTER_RE.match(text)
        if not fm_match:
            continue

        fm = fm_match.group(1)
        title_match = TITLE_RE.search(fm)
        if not title_match:
            continue
        fm_title = title_match.group(1).strip()

        body = text[fm_match.end():]
        heading_match = re.search(r"^#\s+(.+)$", body, re.MULTILINE)
        if not heading_match:
            continue
        body_heading = heading_match.group(1).strip()

        if fm_title != body_heading:
            findings.warning(
                f"{rel(path)}: frontmatter title '{fm_title}' differs from "
                f"first heading '{body_heading}'"
            )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    files = collect_md_files()
    findings = Findings()

    validate_folders(findings)

    for path in files:
        fm = parse_frontmatter(path)
        if fm is None:
            findings.error(f"{rel(path)}: no frontmatter found")
            continue

        validate_owners(fm, path, findings)
        validate_soft_links(fm, path, findings)

    validate_directory_listing(findings)
    validate_root_domain_sync(findings)
    validate_soft_link_reciprocity(files, findings)
    validate_empty_nodes(files, findings)
    validate_title_mismatch(files, findings)

    findings.print_report(len(files))
    return 1 if findings.has_errors() else 0


if __name__ == "__main__":
    sys.exit(main())
