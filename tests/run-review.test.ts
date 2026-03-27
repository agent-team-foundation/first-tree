import { describe, expect, it } from "vitest";
import {
  extractStreamText,
  extractReviewJson,
} from "../.context-tree/run-review.js";

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
