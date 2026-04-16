import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  extractStreamText,
  extractReviewJson,
  prepareReviewWorkspace,
  splitDiffByFile,
} from "../assets/tree/helpers/run-review.js";

// --- extractStreamText ---

describe("extractStreamText", () => {
  it("extracts text from assistant message blocks", () => {
    const jsonl = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }],
        },
      }),
    ].join("\n");
    expect(extractStreamText(jsonl)).toBe("Hello world");
  });

  it("falls back to result field when no assistant text", () => {
    const jsonl = JSON.stringify({
      type: "result",
      result: "fallback text",
    });
    expect(extractStreamText(jsonl)).toBe("fallback text");
  });

  it("prefers assistant text over result field", () => {
    const jsonl = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "from assistant" }] },
      }),
      JSON.stringify({
        type: "result",
        result: "from result",
      }),
    ].join("\n");
    expect(extractStreamText(jsonl)).toBe("from assistant");
  });

  it("returns empty string for empty input", () => {
    expect(extractStreamText("")).toBe("");
  });

  it("skips non-text content blocks", () => {
    const jsonl = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "read" },
          { type: "text", text: "actual text" },
        ],
      },
    });
    expect(extractStreamText(jsonl)).toBe("actual text");
  });

  it("handles malformed JSON lines gracefully", () => {
    const jsonl = [
      "not json",
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      }),
      "{broken",
    ].join("\n");
    expect(extractStreamText(jsonl)).toBe("ok");
  });

  it("concatenates text across multiple assistant messages", () => {
    const jsonl = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "part1" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "part2" }] },
      }),
    ].join("\n");
    expect(extractStreamText(jsonl)).toBe("part1part2");
  });
});

// --- extractReviewJson ---

describe("extractReviewJson", () => {
  it("extracts valid review JSON", () => {
    const text = '{"verdict": "APPROVE", "summary": "Looks good"}';
    const result = extractReviewJson(text);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("APPROVE");
    expect(result!.summary).toBe("Looks good");
  });

  it("extracts JSON from markdown fences", () => {
    const text = '```json\n{"verdict": "COMMENT", "summary": "Minor issues"}\n```';
    const result = extractReviewJson(text);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("COMMENT");
  });

  it("extracts JSON embedded in surrounding text", () => {
    const text =
      'Here is my review:\n{"verdict": "REQUEST_CHANGES", "summary": "Needs work"}\nEnd of review.';
    const result = extractReviewJson(text);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe("REQUEST_CHANGES");
  });

  it("extracts JSON with inline_comments", () => {
    const text = JSON.stringify({
      verdict: "COMMENT",
      summary: "Some notes",
      inline_comments: [
        { file: "src/foo.ts", line: 10, comment: "Fix this" },
      ],
    });
    const result = extractReviewJson(text);
    expect(result).not.toBeNull();
    expect(result!.inline_comments).toHaveLength(1);
    expect(result!.inline_comments![0].file).toBe("src/foo.ts");
  });

  it("returns null for empty string", () => {
    expect(extractReviewJson("")).toBeNull();
  });

  it("returns null for whitespace only", () => {
    expect(extractReviewJson("   \n  ")).toBeNull();
  });

  it("returns null for text without JSON", () => {
    expect(extractReviewJson("No JSON here, just text.")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(extractReviewJson("{verdict: APPROVE}")).toBeNull();
  });

  it("returns null for JSON without verdict", () => {
    expect(
      extractReviewJson('{"summary": "Missing verdict field"}'),
    ).toBeNull();
  });

  it("returns null for JSON with empty verdict", () => {
    expect(
      extractReviewJson('{"verdict": "", "summary": "Empty"}'),
    ).toBeNull();
  });
});

// --- splitDiffByFile ---

describe("splitDiffByFile", () => {
  it("splits a multi-file diff into per-file sections", () => {
    const diff = [
      "diff --git a/foo.md b/foo.md",
      "index 1111111..2222222 100644",
      "--- a/foo.md",
      "+++ b/foo.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/bar/NODE.md b/bar/NODE.md",
      "index 3333333..4444444 100644",
      "--- a/bar/NODE.md",
      "+++ b/bar/NODE.md",
      "@@ -1 +1 @@",
      "-old node",
      "+new node",
    ].join("\n");

    const sections = splitDiffByFile(diff);
    expect(sections).toHaveLength(2);
    expect(sections[0].path).toBe("foo.md");
    expect(sections[0].patch).toContain("+new");
    expect(sections[1].path).toBe("bar/NODE.md");
    expect(sections[1].patch).toContain("+new node");
  });
});

// --- prepareReviewWorkspace / buildPrompt ---

describe("review workspace preparation", () => {
  it("writes manifest and per-file patches for on-demand inspection", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "first-tree-review-test-"));
    const diffPath = join(tempDir, "pr.diff");
    const metadataPath = join(tempDir, "pr-metadata.json");
    const workspaceRoot = join(tempDir, "workspace");

    writeFileSync(
      diffPath,
      [
        "diff --git a/foo.md b/foo.md",
        "index 1111111..2222222 100644",
        "--- a/foo.md",
        "+++ b/foo.md",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    );
    writeFileSync(
      metadataPath,
      JSON.stringify({
        url: "https://github.com/example/repo/pull/1",
        title: "Review me",
        files: [{ path: "foo.md", additions: 1, deletions: 1 }],
      }),
    );

    const workspace = prepareReviewWorkspace(diffPath, {
      prMetadataPath: metadataPath,
      workspaceRoot,
    });

    expect(workspace.files).toHaveLength(1);
    expect(workspace.files[0].patchPath).toBeDefined();
    expect(readFileSync(workspace.manifestPath, "utf-8")).toContain(
      "https://github.com/example/repo/pull/1",
    );
    expect(readFileSync(workspace.files[0].patchPath!, "utf-8")).toContain(
      "diff --git a/foo.md b/foo.md",
    );
  });

  it("keeps the raw diff out of the initial prompt", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "first-tree-review-prompt-"));
    const diffPath = join(tempDir, "pr.diff");
    const metadataPath = join(tempDir, "pr-metadata.json");
    const reviewPromptPath = join(tempDir, "review.md");
    const workspaceRoot = join(tempDir, "workspace");
    const uniqueDiffMarker = "UNIQUE_DIFF_MARKER_FOR_PROMPT";
    const originalCwd = process.cwd();

    writeFileSync(join(tempDir, "AGENTS.md"), "# Instructions\n\nFollow the tree rules.");
    writeFileSync(join(tempDir, "NODE.md"), "---\ntitle: Root\nowners: [*]\n---\n\n# Root");
    writeFileSync(reviewPromptPath, "Return ONLY JSON.");
    writeFileSync(
      diffPath,
      [
        "diff --git a/foo.md b/foo.md",
        "index 1111111..2222222 100644",
        "--- a/foo.md",
        "+++ b/foo.md",
        "@@ -1 +1 @@",
        `+${uniqueDiffMarker}`,
      ].join("\n"),
    );
    writeFileSync(
      metadataPath,
      JSON.stringify({
        url: "https://github.com/example/repo/pull/1",
        title: "Prompt check",
        files: [{ path: "foo.md", additions: 1, deletions: 0 }],
      }),
    );

    process.chdir(tempDir);
    try {
      const prompt = buildPrompt(diffPath, reviewPromptPath, {
        prMetadataPath: metadataPath,
        workspaceRoot,
      });

      expect(prompt).toContain("https://github.com/example/repo/pull/1");
      expect(prompt).toContain("Structured manifest JSON");
      expect(prompt).not.toContain(uniqueDiffMarker);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
