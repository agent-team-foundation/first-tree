import { describe, expect, it } from "vitest";
import {
  nextParamsForClearFilters,
  nextParamsForEngagement,
  nextParamsForGroup,
  nextParamsForOrigin,
  nextParamsForParticipants,
  nextParamsForUnread,
  nextParamsForWatching,
  parseOriginList,
  parseParticipantList,
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

  it("leaves watching alone (Phase B — the two dimensions are independent)", () => {
    // Phase A enforced mutual exclusivity because the server `filter`
    // enum could only carry one of {unread, watching} at a time. Phase
    // B lifted `watching` to an independent boolean, so toggling
    // `unread` no longer disturbs `watching`.
    const result = nextParamsForUnread(paramsOf("watching=1"), true);
    expect(result.get("unread")).toBe("1");
    expect(result.get("watching")).toBe("1");
  });

  it("preserves the chat selection (unlike scope toggles)", () => {
    const result = nextParamsForUnread(paramsOf("c=abc"), true);
    expect(result.get("c")).toBe("abc");
  });
});

describe("nextParamsForWatching", () => {
  it("sets watching=1 when enabling", () => {
    const result = nextParamsForWatching(paramsOf(""), true);
    expect(result.get("watching")).toBe("1");
  });

  it("removes watching when disabling", () => {
    const result = nextParamsForWatching(paramsOf("watching=1"), false);
    expect(result.has("watching")).toBe(false);
  });

  it("leaves unread alone (Phase B — independent dimensions)", () => {
    const result = nextParamsForWatching(paramsOf("unread=1"), true);
    expect(result.get("watching")).toBe("1");
    expect(result.get("unread")).toBe("1");
  });
});

describe("parseUnreadWatching", () => {
  it("reads each flag independently when only one is set", () => {
    expect(parseUnreadWatching(paramsOf("unread=1"))).toEqual({ unread: true, watching: false });
    expect(parseUnreadWatching(paramsOf("watching=1"))).toEqual({ unread: false, watching: true });
  });

  it("reads both flags as true when both are set (Phase B)", () => {
    // Phase B server accepts both dimensions independently, so the URL
    // can legitimately encode "unread chats I'm watching". The parser
    // is straight-through — no more Phase A canonicalisation.
    expect(parseUnreadWatching(paramsOf("unread=1&watching=1"))).toEqual({ unread: true, watching: true });
  });

  it("defaults both off when neither key is present", () => {
    expect(parseUnreadWatching(paramsOf(""))).toEqual({ unread: false, watching: false });
    expect(parseUnreadWatching(paramsOf("c=abc"))).toEqual({ unread: false, watching: false });
  });

  it("treats non-`1` values as absent", () => {
    expect(parseUnreadWatching(paramsOf("unread=true&watching=yes"))).toEqual({ unread: false, watching: false });
  });
});

describe("parseOriginList", () => {
  it("returns an empty list when the key is missing or empty", () => {
    expect(parseOriginList(paramsOf(""))).toEqual([]);
    expect(parseOriginList(paramsOf("origin="))).toEqual([]);
  });

  it("parses a single origin", () => {
    expect(parseOriginList(paramsOf("origin=manual"))).toEqual(["manual"]);
  });

  it("parses comma-joined multi-value", () => {
    expect(parseOriginList(paramsOf("origin=manual,github"))).toEqual(["manual", "github"]);
  });

  it("silently drops unknown / future-rolled-back ChatSource literals", () => {
    // A URL with an unfamiliar source string (typo, deprecated value,
    // or a token introduced after a partial rollback) shouldn't break
    // the rail — those tokens just don't filter anything. Also covers
    // pre-Phase-C names like `github_pull_request` that used to be
    // valid ChatSource values but no longer are; they decay to "no
    // filter" so the rail shows every origin instead of erroring.
    expect(parseOriginList(paramsOf("origin=manual,unknown,github_pull_request"))).toEqual(["manual"]);
  });

  it("trims whitespace and dedupes", () => {
    expect(parseOriginList(paramsOf("origin=manual,%20github%20,manual"))).toEqual(["manual", "github"]);
  });
});

describe("parseParticipantList", () => {
  it("returns an empty list when the key is missing or empty", () => {
    expect(parseParticipantList(paramsOf(""))).toEqual([]);
    expect(parseParticipantList(paramsOf("with="))).toEqual([]);
  });

  it("parses comma-joined ids with trim + dedupe", () => {
    expect(parseParticipantList(paramsOf("with=agent-a,%20agent-b%20,agent-a"))).toEqual(["agent-a", "agent-b"]);
  });
});

describe("nextParamsForOrigin", () => {
  it("sets a comma-joined list", () => {
    const result = nextParamsForOrigin(paramsOf(""), ["manual", "github"]);
    expect(result.get("origin")).toBe("manual,github");
  });

  it("deduplicates the input", () => {
    const result = nextParamsForOrigin(paramsOf(""), ["manual", "manual", "github"]);
    expect(result.get("origin")).toBe("manual,github");
  });

  it("removes the key on an empty list (canonical home URL stays bare)", () => {
    const result = nextParamsForOrigin(paramsOf("origin=manual"), []);
    expect(result.has("origin")).toBe(false);
  });

  it("clears the chat selection (narrowing can hide the current chat)", () => {
    const result = nextParamsForOrigin(paramsOf("c=abc&origin=manual"), ["github"]);
    expect(result.has("c")).toBe(false);
    expect(result.get("origin")).toBe("github");
  });
});

describe("nextParamsForParticipants", () => {
  it("sets a comma-joined list and filters out empty entries", () => {
    const result = nextParamsForParticipants(paramsOf(""), ["agent-a", "", "agent-b"]);
    expect(result.get("with")).toBe("agent-a,agent-b");
  });

  it("removes the key on an empty list", () => {
    const result = nextParamsForParticipants(paramsOf("with=agent-a"), []);
    expect(result.has("with")).toBe(false);
  });

  it("clears the chat selection", () => {
    const result = nextParamsForParticipants(paramsOf("c=abc&with=agent-a"), ["agent-b"]);
    expect(result.has("c")).toBe(false);
  });
});

describe("nextParamsForClearFilters", () => {
  it("strips every rail filter dimension in a single mutation", () => {
    // The Clear handler must clear `unread` / `watching` / `origin` /
    // `with` atomically because two sequential `setSearchParams` calls
    // would each derive from the same render-stale params and the
    // second would clobber the first.
    const result = nextParamsForClearFilters(paramsOf("unread=1&watching=1&origin=manual,github&with=agent-a,agent-b"));
    expect(result.has("unread")).toBe(false);
    expect(result.has("watching")).toBe(false);
    expect(result.has("origin")).toBe(false);
    expect(result.has("with")).toBe(false);
  });

  it("preserves non-filter params (scope, chat selection, group)", () => {
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
  it("drops the param for the default `source` mode", () => {
    // Default omitted from URL so the canonical home page stays `/`.
    const result = nextParamsForGroup(paramsOf("group=recency"), "source");
    expect(result.has("group")).toBe(false);
  });

  it("sets non-default modes", () => {
    expect(nextParamsForGroup(paramsOf(""), "recency").get("group")).toBe("recency");
  });

  it("preserves the chat selection (grouping is purely visual)", () => {
    const result = nextParamsForGroup(paramsOf("c=abc"), "recency");
    expect(result.get("c")).toBe("abc");
  });
});
