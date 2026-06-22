import { describe, expect, it } from "vitest";
import { activeTokenCount, formatTokenUsageTitle, processedTokenCount } from "../token-usage.js";

describe("token usage helpers", () => {
  it("keeps active and processed token counts distinct", () => {
    const usage = { inputTokens: 100, cachedInputTokens: 250, outputTokens: 50 };

    expect(activeTokenCount(usage)).toBe(150);
    expect(processedTokenCount(usage)).toBe(400);
    expect(formatTokenUsageTitle(usage, { turns: 2 })).toBe(
      "Processed 400 · Active 150 · Input 100 · Cached 250 · Output 50 · 2 usage events",
    );
  });

  it("treats missing cached fields as zero for legacy or mocked data", () => {
    expect(processedTokenCount({ inputTokens: 100, outputTokens: 50 })).toBe(150);
  });
});
