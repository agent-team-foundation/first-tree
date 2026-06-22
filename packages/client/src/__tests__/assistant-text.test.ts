import { describe, expect, it } from "vitest";
import { ASSISTANT_TEXT_EVENT_LIMIT, chunkAssistantText } from "../handlers/assistant-text.js";

describe("chunkAssistantText", () => {
  it("returns [] for whitespace-only input", () => {
    expect(chunkAssistantText("")).toEqual([]);
    expect(chunkAssistantText("   \n\t ")).toEqual([]);
  });

  it("returns a single chunk for text at or under the limit", () => {
    expect(chunkAssistantText("hello")).toEqual(["hello"]);
    const exact = "x".repeat(ASSISTANT_TEXT_EVENT_LIMIT);
    expect(chunkAssistantText(exact)).toEqual([exact]);
  });

  it("splits text over the limit into consecutive chunks with NO loss", () => {
    const text = "a".repeat(ASSISTANT_TEXT_EVENT_LIMIT) + "b".repeat(ASSISTANT_TEXT_EVENT_LIMIT) + "ccc";
    const chunks = chunkAssistantText(text);

    expect(chunks).toHaveLength(3);
    // Every chunk fits the per-event cap...
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(ASSISTANT_TEXT_EVENT_LIMIT);
    // ...and concatenating them reproduces the full input exactly (lossless).
    expect(chunks.join("")).toBe(text);
  });

  it("honors a custom limit", () => {
    expect(chunkAssistantText("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
    expect(chunkAssistantText("abcde", 2).join("")).toBe("abcde");
  });
});
