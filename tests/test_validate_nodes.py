"""Tests for .context-tree/validate_nodes.py"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Import the module from the dot-prefixed directory
# ---------------------------------------------------------------------------
_spec = importlib.util.spec_from_file_location(
    "validate_nodes",
    Path(__file__).parent.parent / ".context-tree" / "validate_nodes.py",
)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

Findings = mod.Findings


# ---------------------------------------------------------------------------
# Fixture: patch TREE_ROOT and clear caches between tests
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _patch_tree_root(tmp_path):
    """Point the module's TREE_ROOT at a fresh tmp_path for every test."""
    original_root = mod.TREE_ROOT
    original_cache = mod._text_cache.copy()
    mod.TREE_ROOT = tmp_path
    mod._text_cache.clear()
    yield tmp_path
    mod.TREE_ROOT = original_root
    mod._text_cache.clear()
    mod._text_cache.update(original_cache)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _write(tmp_path: Path, rel: str, content: str) -> Path:
    p = tmp_path / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    return p


# ===================================================================
# parse_frontmatter
# ===================================================================
class TestParseFrontmatter:
    def test_valid(self, tmp_path):
        p = _write(tmp_path, "NODE.md", "---\ntitle: Hello\nowners: [alice]\n---\n# Hello\n")
        assert mod.parse_frontmatter(p) is not None
        assert "title: Hello" in mod.parse_frontmatter(p)

    def test_missing(self, tmp_path):
        p = _write(tmp_path, "NODE.md", "# No frontmatter here\n")
        assert mod.parse_frontmatter(p) is None

    def test_malformed(self, tmp_path):
        p = _write(tmp_path, "NODE.md", "---\ntitle: Oops\nNo closing fence\n")
        assert mod.parse_frontmatter(p) is None


# ===================================================================
# parse_soft_links
# ===================================================================
class TestParseSoftLinks:
    def test_inline(self):
        fm = 'owners: [alice]\nsoft_links: [/a, /b]'
        assert mod.parse_soft_links(fm) == ["/a", "/b"]

    def test_block(self):
        fm = "owners: [alice]\nsoft_links:\n  - /x\n  - /y\n"
        assert mod.parse_soft_links(fm) == ["/x", "/y"]

    def test_empty_inline(self):
        fm = "owners: [alice]\nsoft_links: []"
        assert mod.parse_soft_links(fm) == []

    def test_missing(self):
        fm = "owners: [alice]"
        assert mod.parse_soft_links(fm) is None


# ===================================================================
# validate_owners
# ===================================================================
class TestValidateOwners:
    def test_valid(self, tmp_path):
        p = _write(tmp_path, "NODE.md", "---\nowners: [alice, bob]\n---\n")
        fm = mod.parse_frontmatter(p)
        f = Findings()
        mod.validate_owners(fm, p, f)
        assert not f.errors

    def test_wildcard(self, tmp_path):
        p = _write(tmp_path, "NODE.md", "---\nowners: [*]\n---\n")
        fm = mod.parse_frontmatter(p)
        f = Findings()
        mod.validate_owners(fm, p, f)
        assert not f.errors

    def test_empty_inheritance(self, tmp_path):
        p = _write(tmp_path, "NODE.md", "---\nowners: []\n---\n")
        fm = mod.parse_frontmatter(p)
        f = Findings()
        mod.validate_owners(fm, p, f)
        assert not f.errors

    def test_invalid_username(self, tmp_path):
        p = _write(tmp_path, "NODE.md", "---\nowners: [not valid!]\n---\n")
        fm = mod.parse_frontmatter(p)
        f = Findings()
        mod.validate_owners(fm, p, f)
        assert len(f.errors) == 1
        assert "invalid owner" in f.errors[0]

    def test_mixed_wildcard(self, tmp_path):
        p = _write(tmp_path, "NODE.md", "---\nowners: [alice, *]\n---\n")
        fm = mod.parse_frontmatter(p)
        f = Findings()
        mod.validate_owners(fm, p, f)
        assert len(f.errors) == 1
        assert "wildcard" in f.errors[0]


# ===================================================================
# validate_folders
# ===================================================================
class TestValidateFolders:
    def test_missing_node_md(self, tmp_path):
        subdir = tmp_path / "domain"
        subdir.mkdir()
        # No NODE.md inside
        f = Findings()
        mod.validate_folders(f)
        assert any("missing NODE.md" in e for e in f.errors)

    def test_valid_folder(self, tmp_path):
        subdir = tmp_path / "domain"
        subdir.mkdir()
        (subdir / "NODE.md").write_text("---\nowners: [a]\n---\n# D\n")
        f = Findings()
        mod.validate_folders(f)
        assert not f.errors


# ===================================================================
# validate_empty_nodes
# ===================================================================
class TestValidateEmptyNodes:
    def test_short_body(self, tmp_path):
        p = _write(tmp_path, "NODE.md", "---\nowners: [a]\n---\n\n")
        f = Findings()
        mod.validate_empty_nodes([p], f)
        assert any("little or no body content" in w for w in f.warnings)

    def test_adequate_body(self, tmp_path):
        body = "This is a meaningful body with enough content to pass the threshold easily."
        p = _write(tmp_path, "NODE.md", f"---\nowners: [a]\n---\n{body}\n")
        f = Findings()
        mod.validate_empty_nodes([p], f)
        assert not f.warnings


# ===================================================================
# validate_title_mismatch
# ===================================================================
class TestValidateTitleMismatch:
    def test_matching(self, tmp_path):
        p = _write(tmp_path, "NODE.md", '---\ntitle: Hello World\nowners: [a]\n---\n# Hello World\n')
        f = Findings()
        mod.validate_title_mismatch([p], f)
        assert not f.warnings

    def test_mismatched(self, tmp_path):
        p = _write(tmp_path, "NODE.md", '---\ntitle: Hello\nowners: [a]\n---\n# Goodbye\n')
        f = Findings()
        mod.validate_title_mismatch([p], f)
        assert len(f.warnings) == 1
        assert "differs from" in f.warnings[0]
