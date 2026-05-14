import { describe, expect, it } from "vitest";
import { nextParamsForEngagement, nextParamsForSource } from "../index.js";

function paramsOf(search: string): URLSearchParams {
  return new URLSearchParams(search);
}

describe("nextParamsForSource", () => {
  it("clears the chat selection so the right pane can't receive misrouted input", () => {
    // Regression: issue 388 — switching the source tag bar previously left
    // `?c=` pointing at a chat from the old tag, leaving the right pane on
    // the wrong conversation while the rail showed a different list.
    const result = nextParamsForSource(paramsOf("c=abc-123&source=manual"), "github_pull_request");
    expect(result.has("c")).toBe(false);
    expect(result.get("source")).toBe("github_pull_request");
  });

  it("drops the source key for the default `manual` tab to keep `/` canonical", () => {
    const result = nextParamsForSource(paramsOf("source=feishu&c=xyz"), "manual");
    expect(result.has("source")).toBe(false);
    expect(result.has("c")).toBe(false);
  });

  it("clears any doc-preview overlay along with the chat selection", () => {
    const result = nextParamsForSource(
      paramsOf("c=abc&source=manual&docChat=a&docAgent=b&docPath=p&docBase=base"),
      "github_issue",
    );
    expect(result.has("docChat")).toBe(false);
    expect(result.has("docAgent")).toBe(false);
    expect(result.has("docPath")).toBe(false);
    expect(result.has("docBase")).toBe(false);
  });

  it("preserves unrelated params (engagement, filter, etc.)", () => {
    const result = nextParamsForSource(paramsOf("c=x&source=manual&engagement=archived"), "github_pull_request");
    expect(result.get("engagement")).toBe("archived");
  });
});

describe("nextParamsForEngagement", () => {
  it("clears the chat selection when switching engagement tabs", () => {
    // Same misrouted-input risk as the source tab: an active chat is hidden
    // when you flip to Archived, so the right pane must reset too.
    const result = nextParamsForEngagement(paramsOf("c=abc&engagement=active"), "archived");
    expect(result.has("c")).toBe(false);
    expect(result.get("engagement")).toBe("archived");
  });

  it("drops the engagement key for the default `active` tab", () => {
    const result = nextParamsForEngagement(paramsOf("engagement=all&c=abc"), "active");
    expect(result.has("engagement")).toBe(false);
    expect(result.has("c")).toBe(false);
  });

  it("clears any doc-preview overlay", () => {
    const result = nextParamsForEngagement(
      paramsOf("c=abc&engagement=active&docChat=a&docAgent=b&docPath=p&docBase=base"),
      "all",
    );
    expect(result.has("docChat")).toBe(false);
    expect(result.has("docAgent")).toBe(false);
    expect(result.has("docPath")).toBe(false);
    expect(result.has("docBase")).toBe(false);
  });

  it("preserves unrelated params (source, etc.)", () => {
    const result = nextParamsForEngagement(paramsOf("c=x&source=feishu&engagement=active"), "archived");
    expect(result.get("source")).toBe("feishu");
  });
});
