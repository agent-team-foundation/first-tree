"""Tests for .context-tree/validate_members.py"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Import the module from the dot-prefixed directory
# ---------------------------------------------------------------------------
_spec = importlib.util.spec_from_file_location(
    "validate_members",
    Path(__file__).parent.parent / ".context-tree" / "validate_members.py",
)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)


# ---------------------------------------------------------------------------
# Fixture: patch TREE_ROOT and MEMBERS_DIR
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _patch_roots(tmp_path):
    original_root = mod.TREE_ROOT
    original_members = mod.MEMBERS_DIR
    mod.TREE_ROOT = tmp_path
    mod.MEMBERS_DIR = tmp_path / "members"
    yield tmp_path
    mod.TREE_ROOT = original_root
    mod.MEMBERS_DIR = original_members


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _write(tmp_path: Path, rel: str, content: str) -> Path:
    p = tmp_path / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    return p


VALID_MEMBER = """\
---
title: Alice
owners: [alice]
type: human
role: Engineer
domains: [engineering]
---
# Alice
"""


# ===================================================================
# validate_member
# ===================================================================
class TestValidateMember:
    def test_valid(self, tmp_path):
        p = _write(tmp_path, "members/alice/NODE.md", VALID_MEMBER)
        errors = mod.validate_member(p)
        assert errors == []

    def test_missing_title(self, tmp_path):
        content = "---\nowners: [alice]\ntype: human\nrole: Eng\ndomains: [eng]\n---\n"
        p = _write(tmp_path, "members/alice/NODE.md", content)
        errors = mod.validate_member(p)
        assert any("title" in e for e in errors)

    def test_missing_type(self, tmp_path):
        content = "---\ntitle: Alice\nowners: [alice]\nrole: Eng\ndomains: [eng]\n---\n"
        p = _write(tmp_path, "members/alice/NODE.md", content)
        errors = mod.validate_member(p)
        assert any("type" in e for e in errors)

    def test_invalid_type(self, tmp_path):
        content = "---\ntitle: Alice\nowners: [alice]\ntype: robot\nrole: Eng\ndomains: [eng]\n---\n"
        p = _write(tmp_path, "members/alice/NODE.md", content)
        errors = mod.validate_member(p)
        assert any("invalid type" in e for e in errors)

    def test_missing_domains(self, tmp_path):
        content = "---\ntitle: Alice\nowners: [alice]\ntype: human\nrole: Eng\n---\n"
        p = _write(tmp_path, "members/alice/NODE.md", content)
        errors = mod.validate_member(p)
        assert any("domains" in e for e in errors)


# ===================================================================
# extract_scalar
# ===================================================================
class TestExtractScalar:
    def test_regular(self):
        fm = "title: Hello World\nowners: [a]"
        assert mod.extract_scalar(fm, "title") == "Hello World"

    def test_quoted(self):
        fm = 'title: "Hello World"\nowners: [a]'
        assert mod.extract_scalar(fm, "title") == "Hello World"

    def test_missing(self):
        fm = "owners: [a]"
        assert mod.extract_scalar(fm, "title") is None


# ===================================================================
# extract_list
# ===================================================================
class TestExtractList:
    def test_inline(self):
        fm = "domains: [eng, product]"
        assert mod.extract_list(fm, "domains") == ["eng", "product"]

    def test_block(self):
        fm = "domains:\n  - eng\n  - product\n"
        assert mod.extract_list(fm, "domains") == ["eng", "product"]

    def test_empty(self):
        fm = "domains: []"
        assert mod.extract_list(fm, "domains") == []

    def test_missing(self):
        fm = "owners: [a]"
        assert mod.extract_list(fm, "domains") is None
