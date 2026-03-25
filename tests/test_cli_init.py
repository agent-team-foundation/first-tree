"""Tests for context_tree_cli.init — formatting, progress writing, and guard logic."""

from __future__ import annotations

from pathlib import Path

import pytest

from context_tree_cli.init import _format_task_list, _write_progress, run_init
from context_tree_cli.repo import Repo


# ---------------------------------------------------------------------------
# _format_task_list
# ---------------------------------------------------------------------------

class TestFormatTaskList:
    def test_produces_markdown_heading(self) -> None:
        groups = [
            {"group": "Framework", "order": 1, "tasks": ["Install framework"]},
        ]
        output = _format_task_list(groups)
        assert output.startswith("# Context Tree Init")

    def test_includes_group_heading(self) -> None:
        groups = [
            {"group": "Framework", "order": 1, "tasks": ["Install framework"]},
        ]
        output = _format_task_list(groups)
        assert "## Framework" in output

    def test_includes_task_as_checkbox(self) -> None:
        groups = [
            {"group": "Root Node", "order": 2, "tasks": ["Fix title"]},
        ]
        output = _format_task_list(groups)
        assert "- [ ] Fix title" in output

    def test_multiple_groups(self) -> None:
        groups = [
            {"group": "A", "order": 1, "tasks": ["task-a1", "task-a2"]},
            {"group": "B", "order": 2, "tasks": ["task-b1"]},
        ]
        output = _format_task_list(groups)
        assert "## A" in output
        assert "## B" in output
        assert "- [ ] task-a1" in output
        assert "- [ ] task-a2" in output
        assert "- [ ] task-b1" in output

    def test_includes_verification_section(self) -> None:
        groups = [
            {"group": "G", "order": 1, "tasks": ["t"]},
        ]
        output = _format_task_list(groups)
        assert "## Verification" in output
        assert "context-tree verify" in output

    def test_empty_groups(self) -> None:
        output = _format_task_list([])
        assert "# Context Tree Init" in output
        assert "## Verification" in output


# ---------------------------------------------------------------------------
# _write_progress
# ---------------------------------------------------------------------------

class TestWriteProgress:
    def test_writes_to_correct_path(self, tmp_path: Path) -> None:
        repo = Repo(root=tmp_path)
        _write_progress(repo, "# hello\n")
        progress = tmp_path / ".context-tree" / "progress.md"
        assert progress.is_file()
        assert progress.read_text() == "# hello\n"

    def test_creates_directory_if_missing(self, tmp_path: Path) -> None:
        repo = Repo(root=tmp_path)
        _write_progress(repo, "content")
        assert (tmp_path / ".context-tree" / "progress.md").is_file()

    def test_overwrites_existing_file(self, tmp_path: Path) -> None:
        ct = tmp_path / ".context-tree"
        ct.mkdir()
        (ct / "progress.md").write_text("old")
        repo = Repo(root=tmp_path)
        _write_progress(repo, "new")
        assert (ct / "progress.md").read_text() == "new"


# ---------------------------------------------------------------------------
# run_init — guard logic (no network)
# ---------------------------------------------------------------------------

class TestRunInit:
    def test_errors_when_not_git_repo(self, tmp_path: Path, monkeypatch, capsys) -> None:
        """run_init should return 1 when not inside a git repo."""
        monkeypatch.chdir(tmp_path)
        # Patch Repo to use tmp_path (run_init creates Repo() with cwd)
        monkeypatch.setattr(
            "context_tree_cli.init.Repo",
            lambda: Repo(root=tmp_path),
        )
        ret = run_init()
        assert ret == 1
        captured = capsys.readouterr()
        assert "not a git repository" in captured.err.lower()

    def test_skips_clone_when_framework_exists(self, tmp_path: Path, monkeypatch, capsys) -> None:
        """When framework already exists, run_init should NOT call _clone_seed_tree."""
        (tmp_path / ".git").mkdir()
        ct = tmp_path / ".context-tree"
        ct.mkdir()
        (ct / "VERSION").write_text("0.1.0\n")

        monkeypatch.setattr(
            "context_tree_cli.init.Repo",
            lambda: Repo(root=tmp_path),
        )

        clone_called = False
        original_clone = None

        def fake_clone():
            nonlocal clone_called
            clone_called = True
            raise AssertionError("_clone_seed_tree should not be called")

        monkeypatch.setattr("context_tree_cli.init._clone_seed_tree", fake_clone)

        ret = run_init()
        assert ret == 0
        assert not clone_called
