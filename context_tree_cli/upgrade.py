"""Upgrade command: compare versions and generate upgrade task list."""

from __future__ import annotations

import subprocess
import sys

from context_tree_cli.repo import Repo

SEED_TREE_URL = "https://github.com/agent-team-foundation/seed-tree"


def _get_upstream_version(repo: Repo) -> str | None:
    """Fetch the upstream VERSION file content."""
    result = subprocess.run(
        ["git", "fetch", "context-tree-upstream", "--depth", "1"],
        cwd=repo.root,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    result = subprocess.run(
        ["git", "show", "context-tree-upstream/main:.context-tree/VERSION"],
        cwd=repo.root,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def run_upgrade() -> int:
    repo = Repo()

    if not repo.has_framework():
        print(
            "Error: no .context-tree/ found. Run `context-tree init` first.",
            file=sys.stderr,
        )
        return 1

    local_version = repo.read_version() or "unknown"
    print(f"Local framework version: {local_version}\n")

    # Check for upstream remote
    if not repo.has_upstream_remote():
        print("# Context Tree Upgrade\n")
        print("## Setup")
        print(
            f"- [ ] Add upstream remote:"
            f" `git remote add context-tree-upstream {SEED_TREE_URL}`"
        )
        print(
            "- [ ] Then run `context-tree upgrade` again to check for updates"
        )
        return 0

    # Fetch upstream version
    upstream_version = _get_upstream_version(repo)
    if upstream_version is None:
        print("Could not fetch upstream version. Check your network and try again.")
        return 1

    if upstream_version == local_version:
        print(f"Already up to date (v{local_version}).")
        return 0

    print(f"# Context Tree Upgrade — v{local_version} -> v{upstream_version}\n")

    print("## Framework")
    print(
        "- [ ] Pull latest from upstream:"
        " `git fetch context-tree-upstream"
        " && git merge context-tree-upstream/main`"
    )
    print(
        "- [ ] Resolve any conflicts in `.context-tree/`"
        " (framework files should generally take upstream version)"
    )
    print()

    # Check AGENT.md
    if repo.has_agent_md_markers():
        print("## Agent Instructions")
        print(
            "- [ ] Check if AGENT.md framework section needs updating"
            " — compare content between markers to the new template"
        )
        print()

    print("## Verification")
    print(f"- [ ] `.context-tree/VERSION` reads `{upstream_version}`")
    print("- [ ] `validate_nodes.py` passes")
    print("- [ ] AGENT.md framework section matches upstream")
    print()
    return 0
