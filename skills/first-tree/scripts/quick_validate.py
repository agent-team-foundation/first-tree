#!/usr/bin/env python3
"""
Portable quick validator for a skill directory.

This version is intentionally self-contained so it can run in CI and in copied
skill folders without depending on external Python packages.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

MAX_SKILL_NAME_LENGTH = 64


def extract_frontmatter(text: str) -> tuple[bool, str]:
    if not text.startswith("---\n"):
        return False, "No YAML frontmatter found"
    match = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not match:
        return False, "Invalid frontmatter format"
    return True, match.group(1)


def parse_simple_frontmatter(frontmatter: str) -> dict[str, str]:
    data: dict[str, str] = {}
    for line in frontmatter.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if ":" not in stripped:
            continue
        key, value = stripped.split(":", 1)
        key = key.strip()
        value = value.strip()
        if value.startswith(("'", '"')) and value.endswith(("'", '"')) and len(value) >= 2:
            value = value[1:-1]
        data[key] = value
    return data


def validate_skill(skill_path: str) -> tuple[bool, str]:
    skill_dir = Path(skill_path)
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return False, "SKILL.md not found"

    content = skill_md.read_text()
    ok, frontmatter_or_error = extract_frontmatter(content)
    if not ok:
        return False, frontmatter_or_error

    frontmatter = parse_simple_frontmatter(frontmatter_or_error)

    unexpected = set(frontmatter.keys()) - {"name", "description"}
    if unexpected:
      return False, f"Unexpected key(s) in frontmatter: {', '.join(sorted(unexpected))}"

    name = frontmatter.get("name", "").strip()
    if not name:
        return False, "Missing 'name' in frontmatter"
    if not re.match(r"^[a-z0-9-]+$", name):
        return False, f"Name '{name}' should be hyphen-case"
    if name.startswith("-") or name.endswith("-") or "--" in name:
        return False, f"Name '{name}' cannot start/end with hyphen or contain consecutive hyphens"
    if len(name) > MAX_SKILL_NAME_LENGTH:
        return False, f"Name is too long ({len(name)} > {MAX_SKILL_NAME_LENGTH})"

    description = frontmatter.get("description", "").strip()
    if not description:
        return False, "Missing 'description' in frontmatter"
    if len(description) > 1024:
        return False, f"Description is too long ({len(description)} > 1024)"

    openai_yaml = skill_dir / "agents" / "openai.yaml"
    if not openai_yaml.exists():
        return False, "agents/openai.yaml not found"

    return True, "Skill is valid!"


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: quick_validate.py <skill_directory>")
        return 1

    valid, message = validate_skill(sys.argv[1])
    print(message)
    return 0 if valid else 1


if __name__ == "__main__":
    raise SystemExit(main())
