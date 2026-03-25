#!/usr/bin/env python3
"""Run Claude Code review and extract structured JSON output.

Builds the review prompt, invokes Claude Code with stream-json output,
extracts text from the stream, parses the review JSON, and retries up
to 3 times on failure. Writes the validated review JSON to /tmp/review.json.
"""
import json
import os
import re
import subprocess
import sys

CLAUDE_BIN = os.path.expanduser("~/.local/bin/claude")
MAX_ATTEMPTS = 3
# Per-invocation budget cap. Worst case is $1.50 total (3 × $0.50),
# though retries are cheap in practice due to cached context via --continue.
MAX_BUDGET_USD = 0.5


def build_prompt(diff_path: str) -> str:
    """Assemble the review prompt from tree context files and the PR diff."""
    parts = []
    for heading, path in [
        ("AGENT.md", "AGENT.md"),
        ("Root NODE.md", "NODE.md"),
        ("Review Instructions", ".context-tree/prompts/pr-review.md"),
    ]:
        with open(path) as f:
            parts.append(f"## {heading}\n\n{f.read()}")
    with open(diff_path) as f:
        parts.append(f"## PR Diff\n\n```\n{f.read()}```")
    return "\n\n".join(parts)


def run_claude(prompt: str | None = None, *, continue_session: bool = False) -> str:
    """Invoke Claude Code and return extracted text from stream-json output."""
    cmd = [
        CLAUDE_BIN, "-p",
        "--dangerously-skip-permissions",
        "--output-format", "stream-json",
        "--verbose",
        "--max-budget-usd", str(MAX_BUDGET_USD),
    ]
    if continue_session:
        cmd.append("--continue")

    result = subprocess.run(
        cmd,
        input=prompt,
        capture_output=True,
        text=True,
    )
    if result.stderr:
        print(result.stderr, file=sys.stderr)
    if result.returncode != 0:
        print(f"::error::Claude exited with code {result.returncode}")
        sys.exit(1)

    return extract_stream_text(result.stdout)


def extract_stream_text(jsonl: str) -> str:
    """Extract text content from Claude Code stream-json output.

    Uses only assistant message text blocks. Falls back to the result
    field only if no assistant text was found (avoids duplication).
    """
    text_parts = []
    result_text = ""
    for line in jsonl.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("type") == "assistant":
            for block in msg.get("message", {}).get("content", []):
                if block.get("type") == "text":
                    text_parts.append(block["text"])
        if msg.get("type") == "result":
            r = msg.get("result", "")
            if r:
                result_text = r
    # Prefer assistant text blocks; fall back to result field
    if text_parts:
        return "".join(text_parts)
    return result_text


def extract_review_json(text: str) -> dict | None:
    """Extract and validate review JSON from Claude's text output.

    Returns the parsed dict if valid JSON with a verdict field, else None.
    """
    if not text.strip():
        return None
    # Strip markdown fences
    text = re.sub(r"```json\s*", "", text)
    text = re.sub(r"```\s*", "", text)
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        obj = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    if not obj.get("verdict"):
        return None
    return obj


def main():
    prompt = build_prompt("/tmp/pr-diff.txt")
    print(f"=== Prompt size: {len(prompt.encode())} bytes ===")

    text = run_claude(prompt)

    for attempt in range(1, MAX_ATTEMPTS + 1):
        if text.strip():
            print(f"=== Attempt {attempt}: Raw output ===")
            print(text)
            print("=== End raw output ===")
        else:
            print(f"=== Attempt {attempt}: Empty output ===")

        review = extract_review_json(text)
        if review:
            print(f"Valid JSON with verdict='{review['verdict']}' extracted on attempt {attempt}")
            with open("/tmp/review.json", "w") as f:
                json.dump(review, f)
            return

        if attempt == MAX_ATTEMPTS:
            print(f"::error::Failed to extract valid review JSON after {MAX_ATTEMPTS} attempts")
            sys.exit(1)

        if text.strip():
            retry_msg = (
                "Your previous output could not be parsed as valid review JSON. "
                "Please output ONLY a valid JSON object matching the required schema "
                "(with verdict, optional summary, optional inline_comments). "
                "No other text, no markdown fences."
            )
        else:
            retry_msg = (
                "You did not produce any visible text output. "
                "Please output ONLY the review as a valid JSON object with "
                "verdict (required), summary (optional), and inline_comments (optional). "
                "No other text, no markdown fences."
            )

        print(f"::warning::Attempt {attempt} failed, asking Claude to retry...")
        text = run_claude(retry_msg, continue_session=True)


if __name__ == "__main__":
    main()
