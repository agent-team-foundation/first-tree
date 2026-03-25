"""Repository inspection utilities for the context-tree CLI."""

from __future__ import annotations

import re
from pathlib import Path

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)
OWNERS_RE = re.compile(r"^owners:\s*\[([^\]]*)\]", re.MULTILINE)
TITLE_RE = re.compile(r'^title:\s*["\']?(.+?)["\']?\s*$', re.MULTILINE)

FRAMEWORK_BEGIN_MARKER = "<!-- BEGIN CONTEXT-TREE FRAMEWORK"
FRAMEWORK_END_MARKER = "<!-- END CONTEXT-TREE FRAMEWORK -->"


class Repo:
    """Inspects the state of a context tree repository."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = (root or Path.cwd()).resolve()

    def path_exists(self, rel_path: str) -> bool:
        return (self.root / rel_path).exists()

    def file_contains(self, rel_path: str, text: str) -> bool:
        path = self.root / rel_path
        if not path.is_file():
            return False
        try:
            return text in path.read_text()
        except OSError:
            return False

    def read_file(self, rel_path: str) -> str | None:
        path = self.root / rel_path
        try:
            return path.read_text()
        except OSError:
            return None

    def frontmatter(self, rel_path: str) -> dict | None:
        """Parse frontmatter from a markdown file. Returns dict with 'title' and 'owners' if found."""
        text = self.read_file(rel_path)
        if text is None:
            return None
        m = FRONTMATTER_RE.match(text)
        if not m:
            return None
        fm = m.group(1)
        result = {}
        title_m = TITLE_RE.search(fm)
        if title_m:
            result["title"] = title_m.group(1).strip()
        owners_m = OWNERS_RE.search(fm)
        if owners_m:
            raw = owners_m.group(1).strip()
            result["owners"] = [o.strip() for o in raw.split(",") if o.strip()] if raw else []
        return result if result else None

    def any_agent_config(self) -> bool:
        """Check if any recognized agent configuration exists."""
        known_configs = [
            ".claude/settings.json",
            ".codex/config.json",
        ]
        return any(self.path_exists(c) for c in known_configs)

    def is_git_repo(self) -> bool:
        return (self.root / ".git").is_dir()

    def has_framework(self) -> bool:
        return self.path_exists(".context-tree/VERSION")

    def read_version(self) -> str | None:
        text = self.read_file(".context-tree/VERSION")
        return text.strip() if text else None

    def has_agent_md_markers(self) -> bool:
        """Check if AGENT.md exists and contains framework markers."""
        text = self.read_file("AGENT.md")
        if text is None:
            return False
        return FRAMEWORK_BEGIN_MARKER in text and FRAMEWORK_END_MARKER in text

    def has_members(self) -> bool:
        members_dir = self.root / "members"
        if not members_dir.is_dir():
            return False
        return (members_dir / "NODE.md").is_file()

    def member_count(self) -> int:
        """Count member directories (directories under members/ with NODE.md)."""
        members_dir = self.root / "members"
        if not members_dir.is_dir():
            return 0
        count = 0
        for child in members_dir.iterdir():
            if child.is_dir() and (child / "NODE.md").is_file():
                count += 1
        return count

    def has_placeholder_node(self) -> bool:
        """Check if root NODE.md still contains placeholder content."""
        return self.file_contains("NODE.md", "<!-- PLACEHOLDER")

    def has_upstream_remote(self) -> bool:
        """Check if the context-tree-upstream git remote exists."""
        import subprocess
        try:
            result = subprocess.run(
                ["git", "remote"],
                cwd=self.root,
                capture_output=True,
                text=True,
            )
            return "context-tree-upstream" in result.stdout.split()
        except (OSError, subprocess.SubprocessError):
            return False
