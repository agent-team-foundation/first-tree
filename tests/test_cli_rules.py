"""Tests for context_tree_cli.rules — individual rule modules and evaluate_all."""

from __future__ import annotations

from pathlib import Path

import pytest

from context_tree_cli.repo import Repo
from context_tree_cli.rules import evaluate_all
from context_tree_cli.rules import (
    agent_instructions,
    agent_integration,
    ci_validation,
    framework,
    members,
    root_node,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_framework(tmp_path: Path) -> None:
    """Create a minimal .context-tree/VERSION."""
    ct = tmp_path / ".context-tree"
    ct.mkdir(exist_ok=True)
    (ct / "VERSION").write_text("0.1.0\n")


def _make_node(tmp_path: Path, *, placeholder: bool = False) -> None:
    """Create a valid root NODE.md."""
    body = "<!-- PLACEHOLDER -->\n" if placeholder else "# Real content\n"
    (tmp_path / "NODE.md").write_text(
        f"---\ntitle: My Org\nowners: [alice]\n---\n{body}"
    )


def _make_agent_md(tmp_path: Path, *, markers: bool = True, user_content: bool = False) -> None:
    """Create AGENT.md with optional markers and user content."""
    parts = []
    if markers:
        parts.append("<!-- BEGIN CONTEXT-TREE FRAMEWORK -->\nframework stuff\n"
                      "<!-- END CONTEXT-TREE FRAMEWORK -->")
    else:
        parts.append("# Agent instructions\n")
    if user_content:
        parts.append("\n# Project-specific\nThis is real user content.\n")
    (tmp_path / "AGENT.md").write_text("\n".join(parts))


def _make_members(tmp_path: Path, count: int = 1) -> None:
    """Create members/ with NODE.md and `count` member sub-dirs."""
    members_dir = tmp_path / "members"
    members_dir.mkdir(exist_ok=True)
    (members_dir / "NODE.md").write_text("---\ntitle: Members\n---\n")
    for i in range(count):
        d = members_dir / f"member-{i}"
        d.mkdir()
        (d / "NODE.md").write_text(f"---\ntitle: Member {i}\n---\n")


# ---------------------------------------------------------------------------
# framework rule
# ---------------------------------------------------------------------------

class TestFrameworkRule:
    def test_missing_framework(self, tmp_path: Path) -> None:
        repo = Repo(root=tmp_path)
        result = framework.evaluate(repo)
        assert result["group"] == "Framework"
        assert len(result["tasks"]) == 1
        assert ".context-tree/" in result["tasks"][0]

    def test_has_framework(self, tmp_path: Path) -> None:
        _make_framework(tmp_path)
        repo = Repo(root=tmp_path)
        result = framework.evaluate(repo)
        assert result["tasks"] == []


# ---------------------------------------------------------------------------
# root_node rule
# ---------------------------------------------------------------------------

class TestRootNodeRule:
    def test_missing_node(self, tmp_path: Path) -> None:
        repo = Repo(root=tmp_path)
        result = root_node.evaluate(repo)
        assert any("missing" in t.lower() for t in result["tasks"])

    def test_no_frontmatter(self, tmp_path: Path) -> None:
        (tmp_path / "NODE.md").write_text("# No frontmatter\n")
        repo = Repo(root=tmp_path)
        result = root_node.evaluate(repo)
        assert any("no frontmatter" in t.lower() for t in result["tasks"])

    def test_placeholder_title(self, tmp_path: Path) -> None:
        (tmp_path / "NODE.md").write_text(
            "---\ntitle: '<YOUR ORG>'\nowners: [alice]\n---\n"
        )
        repo = Repo(root=tmp_path)
        result = root_node.evaluate(repo)
        assert any("placeholder title" in t.lower() for t in result["tasks"])

    def test_placeholder_owners(self, tmp_path: Path) -> None:
        (tmp_path / "NODE.md").write_text(
            "---\ntitle: Real Title\nowners: [<your-github>]\n---\n"
        )
        repo = Repo(root=tmp_path)
        result = root_node.evaluate(repo)
        assert any("placeholder owners" in t.lower() for t in result["tasks"])

    def test_placeholder_content(self, tmp_path: Path) -> None:
        (tmp_path / "NODE.md").write_text(
            "---\ntitle: Real\nowners: [alice]\n---\n<!-- PLACEHOLDER -->\n"
        )
        repo = Repo(root=tmp_path)
        result = root_node.evaluate(repo)
        assert any("placeholder content" in t.lower() for t in result["tasks"])

    def test_valid_node(self, tmp_path: Path) -> None:
        _make_node(tmp_path)
        repo = Repo(root=tmp_path)
        result = root_node.evaluate(repo)
        assert result["tasks"] == []


# ---------------------------------------------------------------------------
# agent_instructions rule
# ---------------------------------------------------------------------------

class TestAgentInstructionsRule:
    def test_missing_agent_md(self, tmp_path: Path) -> None:
        repo = Repo(root=tmp_path)
        result = agent_instructions.evaluate(repo)
        assert any("missing" in t.lower() for t in result["tasks"])

    def test_no_markers(self, tmp_path: Path) -> None:
        _make_agent_md(tmp_path, markers=False)
        repo = Repo(root=tmp_path)
        result = agent_instructions.evaluate(repo)
        assert any("markers" in t.lower() for t in result["tasks"])

    def test_markers_no_user_content(self, tmp_path: Path) -> None:
        _make_agent_md(tmp_path, markers=True, user_content=False)
        repo = Repo(root=tmp_path)
        result = agent_instructions.evaluate(repo)
        assert any("project-specific" in t.lower() for t in result["tasks"])

    def test_markers_with_user_content(self, tmp_path: Path) -> None:
        _make_agent_md(tmp_path, markers=True, user_content=True)
        repo = Repo(root=tmp_path)
        result = agent_instructions.evaluate(repo)
        assert result["tasks"] == []


# ---------------------------------------------------------------------------
# members rule
# ---------------------------------------------------------------------------

class TestMembersRule:
    def test_no_members_dir(self, tmp_path: Path) -> None:
        repo = Repo(root=tmp_path)
        result = members.evaluate(repo)
        assert len(result["tasks"]) >= 1

    def test_members_dir_no_node(self, tmp_path: Path) -> None:
        (tmp_path / "members").mkdir()
        repo = Repo(root=tmp_path)
        result = members.evaluate(repo)
        assert any("NODE.md" in t for t in result["tasks"])

    def test_members_dir_with_node_no_children(self, tmp_path: Path) -> None:
        members_dir = tmp_path / "members"
        members_dir.mkdir()
        (members_dir / "NODE.md").write_text("---\ntitle: Members\n---\n")
        repo = Repo(root=tmp_path)
        result = members.evaluate(repo)
        assert any("at least one member" in t.lower() for t in result["tasks"])

    def test_members_with_children(self, tmp_path: Path) -> None:
        _make_members(tmp_path, count=1)
        repo = Repo(root=tmp_path)
        result = members.evaluate(repo)
        assert result["tasks"] == []


# ---------------------------------------------------------------------------
# agent_integration rule
# ---------------------------------------------------------------------------

class TestAgentIntegrationRule:
    def test_no_agent_config(self, tmp_path: Path) -> None:
        repo = Repo(root=tmp_path)
        result = agent_integration.evaluate(repo)
        assert any("no agent configuration" in t.lower() for t in result["tasks"])

    def test_claude_settings_without_hook(self, tmp_path: Path) -> None:
        (tmp_path / ".claude").mkdir()
        (tmp_path / ".claude" / "settings.json").write_text("{}")
        repo = Repo(root=tmp_path)
        result = agent_integration.evaluate(repo)
        assert any("SessionStart" in t for t in result["tasks"])

    def test_claude_settings_with_hook(self, tmp_path: Path) -> None:
        (tmp_path / ".claude").mkdir()
        (tmp_path / ".claude" / "settings.json").write_text(
            '{"hooks": {"inject-tree-context": true}}'
        )
        repo = Repo(root=tmp_path)
        result = agent_integration.evaluate(repo)
        assert result["tasks"] == []


# ---------------------------------------------------------------------------
# ci_validation rule
# ---------------------------------------------------------------------------

class TestCIValidationRule:
    def test_no_workflows(self, tmp_path: Path) -> None:
        repo = Repo(root=tmp_path)
        result = ci_validation.evaluate(repo)
        assert len(result["tasks"]) == 1

    def test_workflow_without_validate(self, tmp_path: Path) -> None:
        wf_dir = tmp_path / ".github" / "workflows"
        wf_dir.mkdir(parents=True)
        (wf_dir / "ci.yml").write_text("name: CI\non: push\njobs: {}\n")
        repo = Repo(root=tmp_path)
        result = ci_validation.evaluate(repo)
        assert len(result["tasks"]) == 1

    def test_workflow_with_validate(self, tmp_path: Path) -> None:
        wf_dir = tmp_path / ".github" / "workflows"
        wf_dir.mkdir(parents=True)
        (wf_dir / "validate.yml").write_text(
            "name: Validate\non: push\njobs:\n  validate:\n"
            "    steps:\n      - run: python validate_nodes.py\n"
        )
        repo = Repo(root=tmp_path)
        result = ci_validation.evaluate(repo)
        assert result["tasks"] == []


# ---------------------------------------------------------------------------
# evaluate_all
# ---------------------------------------------------------------------------

class TestEvaluateAll:
    def test_returns_sorted_groups(self, tmp_path: Path) -> None:
        """Bare repo should produce multiple groups, sorted by order."""
        repo = Repo(root=tmp_path)
        groups = evaluate_all(repo)
        assert len(groups) >= 2
        orders = [g["order"] for g in groups]
        assert orders == sorted(orders)

    def test_excludes_empty_groups(self, tmp_path: Path) -> None:
        """A fully set-up repo should produce fewer (or zero) groups."""
        _make_framework(tmp_path)
        _make_node(tmp_path)
        _make_agent_md(tmp_path, markers=True, user_content=True)
        _make_members(tmp_path, count=1)
        # Add Claude settings with hook
        (tmp_path / ".claude").mkdir()
        (tmp_path / ".claude" / "settings.json").write_text(
            '{"hooks": {"inject-tree-context": true}}'
        )
        # Add validate workflow
        wf_dir = tmp_path / ".github" / "workflows"
        wf_dir.mkdir(parents=True)
        (wf_dir / "validate.yml").write_text("steps:\n  - run: validate_nodes\n")

        repo = Repo(root=tmp_path)
        groups = evaluate_all(repo)
        # Every group should have tasks (empty ones are excluded)
        for g in groups:
            assert len(g["tasks"]) > 0
