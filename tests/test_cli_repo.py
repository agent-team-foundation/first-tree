"""Tests for context_tree_cli.repo.Repo."""

from __future__ import annotations

from pathlib import Path

import pytest

from context_tree_cli.repo import Repo


# --- path_exists ---

def test_path_exists_existing_file(tmp_path: Path) -> None:
    (tmp_path / "file.txt").write_text("hello")
    repo = Repo(root=tmp_path)
    assert repo.path_exists("file.txt") is True


def test_path_exists_missing_file(tmp_path: Path) -> None:
    repo = Repo(root=tmp_path)
    assert repo.path_exists("no-such-file.txt") is False


# --- file_contains ---

def test_file_contains_text_present(tmp_path: Path) -> None:
    (tmp_path / "f.md").write_text("hello world")
    repo = Repo(root=tmp_path)
    assert repo.file_contains("f.md", "hello") is True


def test_file_contains_text_missing(tmp_path: Path) -> None:
    (tmp_path / "f.md").write_text("hello world")
    repo = Repo(root=tmp_path)
    assert repo.file_contains("f.md", "goodbye") is False


def test_file_contains_file_missing(tmp_path: Path) -> None:
    repo = Repo(root=tmp_path)
    assert repo.file_contains("missing.md", "anything") is False


# --- frontmatter ---

def test_frontmatter_valid_title_and_owners(tmp_path: Path) -> None:
    (tmp_path / "NODE.md").write_text(
        "---\ntitle: My Tree\nowners: [alice, bob]\n---\n# Content\n"
    )
    repo = Repo(root=tmp_path)
    fm = repo.frontmatter("NODE.md")
    assert fm is not None
    assert fm["title"] == "My Tree"
    assert fm["owners"] == ["alice", "bob"]


def test_frontmatter_missing_frontmatter(tmp_path: Path) -> None:
    (tmp_path / "NODE.md").write_text("# Just a heading\nNo frontmatter here.\n")
    repo = Repo(root=tmp_path)
    fm = repo.frontmatter("NODE.md")
    assert fm is None


def test_frontmatter_partial_title_only(tmp_path: Path) -> None:
    (tmp_path / "NODE.md").write_text("---\ntitle: Partial\n---\n")
    repo = Repo(root=tmp_path)
    fm = repo.frontmatter("NODE.md")
    assert fm is not None
    assert fm["title"] == "Partial"
    assert "owners" not in fm


def test_frontmatter_partial_owners_only(tmp_path: Path) -> None:
    (tmp_path / "NODE.md").write_text("---\nowners: [alice]\n---\n")
    repo = Repo(root=tmp_path)
    fm = repo.frontmatter("NODE.md")
    assert fm is not None
    assert fm["owners"] == ["alice"]
    assert "title" not in fm


def test_frontmatter_file_missing(tmp_path: Path) -> None:
    repo = Repo(root=tmp_path)
    fm = repo.frontmatter("NODE.md")
    assert fm is None


# --- any_agent_config ---

def test_any_agent_config_with_claude_settings(tmp_path: Path) -> None:
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "settings.json").write_text("{}")
    repo = Repo(root=tmp_path)
    assert repo.any_agent_config() is True


def test_any_agent_config_without(tmp_path: Path) -> None:
    repo = Repo(root=tmp_path)
    assert repo.any_agent_config() is False


# --- is_git_repo ---

def test_is_git_repo_with_git_dir(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    repo = Repo(root=tmp_path)
    assert repo.is_git_repo() is True


def test_is_git_repo_without_git_dir(tmp_path: Path) -> None:
    repo = Repo(root=tmp_path)
    assert repo.is_git_repo() is False


# --- has_framework ---

def test_has_framework_with_version(tmp_path: Path) -> None:
    (tmp_path / ".context-tree").mkdir()
    (tmp_path / ".context-tree" / "VERSION").write_text("0.1.0\n")
    repo = Repo(root=tmp_path)
    assert repo.has_framework() is True


def test_has_framework_without(tmp_path: Path) -> None:
    repo = Repo(root=tmp_path)
    assert repo.has_framework() is False


# --- read_version ---

def test_read_version_valid(tmp_path: Path) -> None:
    (tmp_path / ".context-tree").mkdir()
    (tmp_path / ".context-tree" / "VERSION").write_text("0.2.0\n")
    repo = Repo(root=tmp_path)
    assert repo.read_version() == "0.2.0"


def test_read_version_missing(tmp_path: Path) -> None:
    repo = Repo(root=tmp_path)
    assert repo.read_version() is None


# --- has_agent_md_markers ---

def test_has_agent_md_markers_with_markers(tmp_path: Path) -> None:
    (tmp_path / "AGENT.md").write_text(
        "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\nstuff\n"
        "<!-- END CONTEXT-TREE FRAMEWORK -->\n"
    )
    repo = Repo(root=tmp_path)
    assert repo.has_agent_md_markers() is True


def test_has_agent_md_markers_without_markers(tmp_path: Path) -> None:
    (tmp_path / "AGENT.md").write_text("# Agent instructions\nNo markers here.\n")
    repo = Repo(root=tmp_path)
    assert repo.has_agent_md_markers() is False


def test_has_agent_md_markers_missing_file(tmp_path: Path) -> None:
    repo = Repo(root=tmp_path)
    assert repo.has_agent_md_markers() is False


# --- has_members ---

def test_has_members_with_node(tmp_path: Path) -> None:
    members = tmp_path / "members"
    members.mkdir()
    (members / "NODE.md").write_text("---\ntitle: Members\n---\n")
    repo = Repo(root=tmp_path)
    assert repo.has_members() is True


def test_has_members_without(tmp_path: Path) -> None:
    repo = Repo(root=tmp_path)
    assert repo.has_members() is False


def test_has_members_dir_without_node(tmp_path: Path) -> None:
    (tmp_path / "members").mkdir()
    repo = Repo(root=tmp_path)
    assert repo.has_members() is False


# --- member_count ---

def test_member_count_zero(tmp_path: Path) -> None:
    repo = Repo(root=tmp_path)
    assert repo.member_count() == 0


def test_member_count_one(tmp_path: Path) -> None:
    members = tmp_path / "members"
    members.mkdir()
    alice = members / "alice"
    alice.mkdir()
    (alice / "NODE.md").write_text("---\ntitle: Alice\n---\n")
    repo = Repo(root=tmp_path)
    assert repo.member_count() == 1


def test_member_count_two(tmp_path: Path) -> None:
    members = tmp_path / "members"
    members.mkdir()
    for name in ("alice", "bob"):
        d = members / name
        d.mkdir()
        (d / "NODE.md").write_text(f"---\ntitle: {name}\n---\n")
    repo = Repo(root=tmp_path)
    assert repo.member_count() == 2


def test_member_count_ignores_dirs_without_node(tmp_path: Path) -> None:
    members = tmp_path / "members"
    members.mkdir()
    (members / "alice").mkdir()  # no NODE.md
    bob = members / "bob"
    bob.mkdir()
    (bob / "NODE.md").write_text("---\ntitle: Bob\n---\n")
    repo = Repo(root=tmp_path)
    assert repo.member_count() == 1


# --- has_placeholder_node ---

def test_has_placeholder_node_with_placeholder(tmp_path: Path) -> None:
    (tmp_path / "NODE.md").write_text(
        "---\ntitle: My Tree\n---\n<!-- PLACEHOLDER: fill in -->\n"
    )
    repo = Repo(root=tmp_path)
    assert repo.has_placeholder_node() is True


def test_has_placeholder_node_without(tmp_path: Path) -> None:
    (tmp_path / "NODE.md").write_text("---\ntitle: My Tree\n---\n# Real content\n")
    repo = Repo(root=tmp_path)
    assert repo.has_placeholder_node() is False
