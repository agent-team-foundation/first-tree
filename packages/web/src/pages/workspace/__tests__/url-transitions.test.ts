import { describe, expect, it } from "vitest";
import { nextParamsForEngagement, nextParamsForGroup, nextParamsForUnread, nextParamsForWatching } from "../index.js";

function paramsOf(search: string): URLSearchParams {
  return new URLSearchParams(search);
}

describe("nextParamsForEngagement", () => {
  it("clears the chat selection when switching engagement tabs", () => {
    // An active chat is hidden when you flip to Archived, so the right
    // pane must reset too — otherwise input lands on a row no longer
    // visible in the rail.
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

  it("preserves unrelated params", () => {
    const result = nextParamsForEngagement(paramsOf("c=x&group=source&engagement=active"), "archived");
    expect(result.get("group")).toBe("source");
  });
});

describe("nextParamsForUnread", () => {
  it("sets unread=1 when enabling", () => {
    const result = nextParamsForUnread(paramsOf(""), true);
    expect(result.get("unread")).toBe("1");
  });

  it("removes unread when disabling", () => {
    const result = nextParamsForUnread(paramsOf("unread=1"), false);
    expect(result.has("unread")).toBe(false);
  });

  it("clears watching when enabling unread (server filter enum is single-valued)", () => {
    // Enabling both `unread` and `watching` would require a single-valued
    // server enum to hold two states; flipping the other off keeps the
    // URL representable on the wire.
    const result = nextParamsForUnread(paramsOf("watching=1"), true);
    expect(result.get("unread")).toBe("1");
    expect(result.has("watching")).toBe(false);
  });

  it("preserves the chat selection (unlike scope toggles)", () => {
    // Unread doesn't hide the selected chat from the rail, so leaving
    // `?c=` alone keeps the reading position stable.
    const result = nextParamsForUnread(paramsOf("c=abc"), true);
    expect(result.get("c")).toBe("abc");
  });
});

describe("nextParamsForWatching", () => {
  it("sets watching=1 when enabling and clears unread", () => {
    const result = nextParamsForWatching(paramsOf("unread=1"), true);
    expect(result.get("watching")).toBe("1");
    expect(result.has("unread")).toBe(false);
  });

  it("removes watching when disabling", () => {
    const result = nextParamsForWatching(paramsOf("watching=1"), false);
    expect(result.has("watching")).toBe(false);
  });
});

describe("nextParamsForGroup", () => {
  it("drops the param for the default `recency` mode", () => {
    // Default omitted from URL so the canonical home page stays `/`.
    const result = nextParamsForGroup(paramsOf("group=source"), "recency");
    expect(result.has("group")).toBe(false);
  });

  it("sets non-default modes", () => {
    expect(nextParamsForGroup(paramsOf(""), "source").get("group")).toBe("source");
    expect(nextParamsForGroup(paramsOf(""), "none").get("group")).toBe("none");
  });

  it("preserves the chat selection (grouping is purely visual)", () => {
    const result = nextParamsForGroup(paramsOf("c=abc"), "source");
    expect(result.get("c")).toBe("abc");
  });
});
