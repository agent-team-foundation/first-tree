"""Tests for context_tree_cli.verify — _check helper and run_verify."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from context_tree_cli.verify import _check, _check_progress, run_verify
from context_tree_cli.repo import Repo


# ---------------------------------------------------------------------------
# _check
# ---------------------------------------------------------------------------

class TestCheck:
    def test_returns_true_on_pass(self, capsys) -> None:
        assert _check("my check", True) is True
        out = capsys.readouterr().out
        assert "PASS" in out
        assert "my check" in out

    def test_returns_false_on_fail(self, capsys) -> None:
        assert _check("my check", False) is False
        out = capsys.readouterr().out
        assert "FAIL" in out
        assert "my check" in out


# ---------------------------------------------------------------------------
# _check_progress
# ---------------------------------------------------------------------------

class TestCheckProgress:
    def test_no_progress_file(self, tmp_path: Path) -> None:
        repo = Repo(root=tmp_path)
        assert _check_progress(repo) == []

    def test_all_checked(self, tmp_path: Path) -> None:
        ct = tmp_path / ".context-tree"
        ct.mkdir()
        (ct / "progress.md").write_text(
            "# Progress\n- [x] Task one\n- [x] Task two\n"
        )
        repo = Repo(root=tmp_path)
        assert _check_progress(repo) == []

    def test_some_unchecked(self, tmp_path: Path) -> None:
        ct = tmp_path / ".context-tree"
        ct.mkdir()
        (ct / "progress.md").write_text(
            "# Progress\n- [x] Done task\n- [ ] Pending task\n- [ ] Another pending\n"
        )
        repo = Repo(root=tmp_path)
        assert _check_progress(repo) == ["Pending task", "Another pending"]

    def test_empty_progress(self, tmp_path: Path) -> None:
        ct = tmp_path / ".context-tree"
        ct.mkdir()
        (ct / "progress.md").write_text("")
        repo = Repo(root=tmp_path)
        assert _check_progress(repo) == []


# ---------------------------------------------------------------------------
# Helpers for building a complete tmp repo
# ---------------------------------------------------------------------------

def _build_full_repo(tmp_path: Path) -> None:
    """Set up tmp_path as a fully passing repo."""
    # .git
    (tmp_path / ".git").mkdir()

    # .context-tree/VERSION
    ct = tmp_path / ".context-tree"
    ct.mkdir()
    (ct / "VERSION").write_text("0.1.0\n")
    (ct / "validate_nodes.py").write_text("# stub\n")

    # Root NODE.md with valid frontmatter
    (tmp_path / "NODE.md").write_text(
        "---\ntitle: My Org\nowners: [alice]\n---\n# Content\n"
    )

    # AGENT.md with markers
    (tmp_path / "AGENT.md").write_text(
        "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\nstuff\n"
        "<!-- END CONTEXT-TREE FRAMEWORK -->\n"
    )

    # members/ with one member
    members = tmp_path / "members"
    members.mkdir()
    (members / "NODE.md").write_text("---\ntitle: Members\n---\n")
    alice = members / "alice"
    alice.mkdir()
    (alice / "NODE.md").write_text("---\ntitle: Alice\n---\n")


# ---------------------------------------------------------------------------
# run_verify — all passing
# ---------------------------------------------------------------------------

class TestRunVerifyAllPass:
    def test_all_checks_pass(self, tmp_path: Path, monkeypatch, capsys) -> None:
        _build_full_repo(tmp_path)
        monkeypatch.setattr(
            "context_tree_cli.verify.Repo",
            lambda: Repo(root=tmp_path),
        )

        # Mock subprocess.run for validate_nodes.py — return success
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = ""
        with patch("context_tree_cli.verify.subprocess.run", return_value=mock_result):
            ret = run_verify()

        assert ret == 0
        out = capsys.readouterr().out
        assert "All checks passed" in out


# ---------------------------------------------------------------------------
# run_verify — failing checks
# ---------------------------------------------------------------------------

class TestRunVerifyFailing:
    def test_missing_framework(self, tmp_path: Path, monkeypatch, capsys) -> None:
        """Empty repo should fail most checks."""
        monkeypatch.setattr(
            "context_tree_cli.verify.Repo",
            lambda: Repo(root=tmp_path),
        )
        ret = run_verify()
        assert ret == 1
        out = capsys.readouterr().out
        assert "FAIL" in out
        assert "Some checks failed" in out

    def test_missing_agent_md(self, tmp_path: Path, monkeypatch, capsys) -> None:
        """Repo with framework but no AGENT.md should fail that check."""
        ct = tmp_path / ".context-tree"
        ct.mkdir()
        (ct / "VERSION").write_text("0.1.0\n")
        (ct / "validate_nodes.py").write_text("# stub\n")
        (tmp_path / "NODE.md").write_text(
            "---\ntitle: My Org\nowners: [alice]\n---\n"
        )
        monkeypatch.setattr(
            "context_tree_cli.verify.Repo",
            lambda: Repo(root=tmp_path),
        )

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = ""
        with patch("context_tree_cli.verify.subprocess.run", return_value=mock_result):
            ret = run_verify()

        assert ret == 1
        out = capsys.readouterr().out
        assert "FAIL" in out

    def test_validate_nodes_failure(self, tmp_path: Path, monkeypatch, capsys) -> None:
        """When validate_nodes.py returns non-zero, the check should fail."""
        _build_full_repo(tmp_path)
        monkeypatch.setattr(
            "context_tree_cli.verify.Repo",
            lambda: Repo(root=tmp_path),
        )

        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stdout = "Error: bad node\n"
        with patch("context_tree_cli.verify.subprocess.run", return_value=mock_result):
            ret = run_verify()

        assert ret == 1
        out = capsys.readouterr().out
        assert "FAIL" in out

    def test_validate_script_missing(self, tmp_path: Path, monkeypatch, capsys) -> None:
        """When validate_nodes.py does not exist, the check should fail."""
        _build_full_repo(tmp_path)
        # Remove the validate script
        (tmp_path / ".context-tree" / "validate_nodes.py").unlink()
        monkeypatch.setattr(
            "context_tree_cli.verify.Repo",
            lambda: Repo(root=tmp_path),
        )
        ret = run_verify()
        assert ret == 1
        out = capsys.readouterr().out
        assert "FAIL" in out
