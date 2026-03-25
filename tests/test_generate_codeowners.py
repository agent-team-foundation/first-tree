"""Tests for .context-tree/generate_codeowners.py"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Import the module from the dot-prefixed directory
# ---------------------------------------------------------------------------
_spec = importlib.util.spec_from_file_location(
    "generate_codeowners",
    Path(__file__).parent.parent / ".context-tree" / "generate_codeowners.py",
)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)


# ---------------------------------------------------------------------------
# Fixture: patch TREE_ROOT and CODEOWNERS_PATH
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _patch_roots(tmp_path):
    original_root = mod.TREE_ROOT
    original_co = mod.CODEOWNERS_PATH
    mod.TREE_ROOT = tmp_path
    mod.CODEOWNERS_PATH = tmp_path / ".github" / "CODEOWNERS"
    yield tmp_path
    mod.TREE_ROOT = original_root
    mod.CODEOWNERS_PATH = original_co


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _write(tmp_path: Path, rel: str, content: str) -> Path:
    p = tmp_path / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    return p


# ===================================================================
# parse_owners
# ===================================================================
class TestParseOwners:
    def test_valid(self, tmp_path):
        p = _write(tmp_path, "NODE.md", "---\nowners: [alice, bob]\n---\n")
        assert mod.parse_owners(p) == ["alice", "bob"]

    def test_empty(self, tmp_path):
        p = _write(tmp_path, "NODE.md", "---\nowners: []\n---\n")
        assert mod.parse_owners(p) == []

    def test_wildcard(self, tmp_path):
        p = _write(tmp_path, "NODE.md", "---\nowners: [*]\n---\n")
        assert mod.parse_owners(p) == ["*"]

    def test_no_frontmatter(self, tmp_path):
        p = _write(tmp_path, "NODE.md", "# Just a heading\n")
        assert mod.parse_owners(p) is None


# ===================================================================
# resolve_node_owners
# ===================================================================
class TestResolveNodeOwners:
    def test_direct(self, tmp_path):
        _write(tmp_path, "NODE.md", "---\nowners: [root-owner]\n---\n")
        _write(tmp_path, "domain/NODE.md", "---\nowners: [domain-owner]\n---\n")
        cache: dict[Path, list[str]] = {}
        result = mod.resolve_node_owners(tmp_path / "domain", cache)
        assert result == ["domain-owner"]

    def test_inheritance_chain(self, tmp_path):
        _write(tmp_path, "NODE.md", "---\nowners: [root-owner]\n---\n")
        # Child with empty owners inherits from root
        _write(tmp_path, "domain/NODE.md", "---\nowners: []\n---\n")
        cache: dict[Path, list[str]] = {}
        result = mod.resolve_node_owners(tmp_path / "domain", cache)
        assert result == ["root-owner"]


# ===================================================================
# collect_entries — dot-prefixed dirs excluded
# ===================================================================
class TestCollectEntries:
    def test_dot_prefixed_excluded(self, tmp_path):
        # Root has owners
        _write(tmp_path, "NODE.md", "---\nowners: [root]\n---\n# Root\n")
        # Normal domain included
        _write(tmp_path, "domain/NODE.md", "---\nowners: [alice]\n---\n# Domain\n")
        # Dot-prefixed directory should be excluded
        _write(tmp_path, ".hidden/NODE.md", "---\nowners: [secret]\n---\n# Hidden\n")

        entries = mod.collect_entries(tmp_path)
        patterns = [pat for pat, _ in entries]
        assert any("domain" in p for p in patterns)
        assert not any(".hidden" in p for p in patterns)


# ===================================================================
# format_owners
# ===================================================================
class TestFormatOwners:
    def test_dedup(self):
        assert mod.format_owners(["alice", "bob", "alice"]) == "@alice @bob"

    def test_at_prefix(self):
        assert mod.format_owners(["alice"]) == "@alice"
