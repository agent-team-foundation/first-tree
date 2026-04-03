#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

SNAPSHOT_PATHS = (
    "AGENTS.md",
    "README.md",
    "package.json",
    "evals/helpers/case-loader.ts",
    "evals/tests/eval-helpers.test.ts",
    ".context-tree",
    "docs",
    "src",
    "tests",
)


def iter_files(root: Path):
    for relative_path in SNAPSHOT_PATHS:
        path = root / relative_path
        if not path.exists():
            raise FileNotFoundError(f"Missing snapshot path: {relative_path}")
        if path.is_file():
            yield relative_path, path
            continue

        for child in sorted(candidate for candidate in path.rglob("*") if candidate.is_file()):
            yield child.relative_to(root).as_posix(), child


def build_fingerprint(root: Path) -> str:
    digest = hashlib.sha256()

    for relative_path, path in iter_files(root):
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")

    return f"sha256:{digest.hexdigest()}"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compute a stable fingerprint for the first-tree portable snapshot inputs.",
    )
    parser.add_argument("--root", required=True, help="Repo root or repo-snapshot root to fingerprint")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    if not root.is_dir():
        print(f"Root is not a directory: {root}", file=sys.stderr)
        return 1

    try:
        print(build_fingerprint(root))
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
