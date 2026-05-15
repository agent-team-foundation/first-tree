import { describe, expect, it } from "vitest";
import {
  nextParamsForClearFilters,
  nextParamsForEngagement,
  nextParamsForGroup,
  nextParamsForUnread,
  nextParamsForWatching,
  parseUnreadWatching,
} from "../index.js";

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

describe("parseUnreadWatching", () => {
  it("reads each flag independently when only one is set", () => {
    expect(parseUnreadWatching(paramsOf("unread=1"))).toEqual({ unread: true, watching: false });
    expect(parseUnreadWatching(paramsOf("watching=1"))).toEqual({ unread: false, watching: true });
  });

  it("canonicalises both-true URLs by letting unread win", () => {
    // A hand-typed or shared URL with both flags set is impossible for
    // the server filter enum to represent. The parser collapses the
    // ambiguity here so the rest of the app sees one consistent state.
    expect(parseUnreadWatching(paramsOf("unread=1&watching=1"))).toEqual({ unread: true, watching: false });
  });

  it("defaults both off when neither key is present", () => {
    expect(parseUnreadWatching(paramsOf(""))).toEqual({ unread: false, watching: false });
    expect(parseUnreadWatching(paramsOf("c=abc"))).toEqual({ unread: false, watching: false });
  });

  it("treats non-`1` values as absent", () => {
    expect(parseUnreadWatching(paramsOf("unread=true&watching=yes"))).toEqual({ unread: false, watching: false });
  });
});

describe("nextParamsForClearFilters", () => {
  it("strips both flags in a single mutation", () => {
    // The Clear handler must clear `unread` and `watching` atomically
    // because two sequential `setSearchParams` calls would each derive
    // from the same render-stale params and the second would clobber
    // the first.
    const result = nextParamsForClearFilters(paramsOf("unread=1&watching=1"));
    expect(result.has("unread")).toBe(false);
    expect(result.has("watching")).toBe(false);
  });

  it("preserves unrelated params (scope, chat selection, group)", () => {
    const result = nextParamsForClearFilters(paramsOf("unread=1&c=abc&engagement=archived&group=source"));
    expect(result.get("c")).toBe("abc");
    expect(result.get("engagement")).toBe("archived");
    expect(result.get("group")).toBe("source");
  });

  it("is idempotent when no filters are active", () => {
    const result = nextParamsForClearFilters(paramsOf("c=abc"));
    expect(result.toString()).toBe("c=abc");
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
