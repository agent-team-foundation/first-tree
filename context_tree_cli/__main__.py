"""Entry point for the context-tree CLI."""

from __future__ import annotations

import sys


USAGE = """\
usage: context-tree <command>

Commands:
  init      Bootstrap a new context tree (clones seed-tree, copies framework files)
  verify    Run verification checks against the current tree
  upgrade   Generate an upgrade task list from upstream changes

Options:
  --help    Show this help message
"""


def main() -> int:
    args = sys.argv[1:]

    if not args or args[0] in ("--help", "-h"):
        print(USAGE)
        return 0

    command = args[0]

    if command == "init":
        from context_tree_cli.init import run_init
        return run_init()
    elif command == "verify":
        from context_tree_cli.verify import run_verify
        return run_verify()
    elif command == "upgrade":
        from context_tree_cli.upgrade import run_upgrade
        return run_upgrade()
    else:
        print(f"Unknown command: {command}")
        print(USAGE)
        return 1


if __name__ == "__main__":
    sys.exit(main())
