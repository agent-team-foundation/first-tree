import { describe, expect, it } from "vitest";
import {
  nextParamsForClearFilters,
  nextParamsForEngagement,
  nextParamsForGroup,
  nextParamsForOrigin,
  nextParamsForParticipants,
  nextParamsForRailFilter,
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

  it("clears any doc-preview overlay (current attachment-ref params + legacy)", () => {
    const result = nextParamsForEngagement(
      paramsOf("c=abc&engagement=active&docChat=a&docMsg=m&docAttachment=att&docAgent=b&docPath=p&docBase=base"),
      "all",
    );
    // Current attachment-ref params — switching engagement must not leave a
    // stale preview behind (R3).
    expect(result.has("docChat")).toBe(false);
    expect(result.has("docMsg")).toBe(false);
    expect(result.has("docAttachment")).toBe(false);
    // Legacy params still cleared for in-flight URLs minted pre-migration.
    expect(result.has("docAgent")).toBe(false);
    expect(result.has("docPath")).toBe(false);
    expect(result.has("docBase")).toBe(false);
  });

  it("preserves unrelated params", () => {
    const result = nextParamsForEngagement(paramsOf("c=x&group=source&engagement=active"), "archived");
    expect(result.get("group")).toBe("source");
  });
});

describe("nextParamsForRailFilter", () => {
  it("`all` clears both unread and watching", () => {
    const result = nextParamsForRailFilter(paramsOf("unread=1&watching=1"), "all");
    expect(result.has("unread")).toBe(false);
    expect(result.has("watching")).toBe(false);
  });

  it("`unread` sets only unread (and clears watching) — single-select", () => {
    const result = nextParamsForRailFilter(paramsOf("watching=1"), "unread");
    expect(result.get("unread")).toBe("1");
    expect(result.has("watching")).toBe(false);
  });

  it("`watching` sets only watching (and clears unread) — single-select", () => {
    const result = nextParamsForRailFilter(paramsOf("unread=1"), "watching");
    expect(result.get("watching")).toBe("1");
    expect(result.has("unread")).toBe(false);
  });

  it("writes both flags in one mutation (mutual exclusivity, no stale-snapshot race)", () => {
    // The whole point of folding the two independent flags into one
    // transition: switching unread → watching must end with exactly one
    // flag set, never both, in a single URLSearchParams write.
    const result = nextParamsForRailFilter(paramsOf("unread=1"), "watching");
    expect(result.get("watching")).toBe("1");
    expect(result.has("unread")).toBe(false);
  });

  it("preserves the chat selection (switching the triad doesn't drop `?c=`)", () => {
    const result = nextParamsForRailFilter(paramsOf("c=abc&unread=1"), "watching");
    expect(result.get("c")).toBe("abc");
  });
});

describe("parseUnreadWatching", () => {
  it("reads each flag independently when only one is set", () => {
    expect(parseUnreadWatching(paramsOf("unread=1"))).toEqual({ unread: true, watching: false });
    expect(parseUnreadWatching(paramsOf("watching=1"))).toEqual({ unread: false, watching: true });
  });

  it("canonicalizes a stale `unread=1&watching=1` combo to single-select (unread wins)", () => {
    // The header triad is single-select, so a URL carrying both flags
    // (a pre-redesign link or hand-typed) resolves to one mode — unread
    // wins — so the applied query matches the highlighted triad instead
    // of silently filtering by both.
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

  it("normalizes the full valid set to unrestricted [] (legacy / shared URL)", () => {
    // A URL that lists every supported source (for example, one produced by
    // the checkbox UI) is semantically unrestricted, like no `?origin=`.
    // lists every source → semantically unrestricted, same as no `?origin=`. It
    // must NOT render a chip per source + a badge, so the parser collapses it to [].
    expect(parseOriginList(paramsOf("origin=manual,github,gitlab,agent"))).toEqual([]);
    // Order / dupes don't matter — a full set in any form collapses to [].
    expect(parseOriginList(paramsOf("origin=agent,manual,gitlab,github,manual"))).toEqual([]);
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

  it("drops the key when handed the full valid set (== unrestricted)", () => {
    const result = nextParamsForOrigin(paramsOf(""), ["manual", "github", "gitlab", "agent"]);
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
  it("clears the popover's own dimensions (Source / Participants / Status) in one mutation", () => {
    // Origin / with / engagement are cleared atomically — two sequential
    // `setSearchParams` calls would each derive from the same render-stale
    // params and the second would clobber the first.
    const result = nextParamsForClearFilters(
      paramsOf("unread=1&watching=1&origin=manual,github&with=agent-a,agent-b&engagement=archived"),
    );
    expect(result.has("origin")).toBe(false);
    expect(result.has("with")).toBe(false);
    expect(result.has("engagement")).toBe(false);
  });

  it("leaves the header triad (unread / watching) untouched — it is a separate control", () => {
    // The All / Unread / Watching triad lives outside the popover and isn't
    // counted by its badge, so "Reset" must NOT silently flip it back to All.
    const withUnread = nextParamsForClearFilters(paramsOf("unread=1&origin=manual"));
    expect(withUnread.get("unread")).toBe("1");
    expect(withUnread.has("origin")).toBe(false);
    const withWatching = nextParamsForClearFilters(paramsOf("watching=1&engagement=archived"));
    expect(withWatching.get("watching")).toBe("1");
    expect(withWatching.has("engagement")).toBe(false);
  });

  it("resets Status (engagement) to default but preserves chat selection + grouping", () => {
    // Status lives in the ⚙ popover and counts toward its active-filter
    // badge, so "Reset" must clear it too; `?group=` (view-mode) and
    // `?c=` (selection) survive.
    const result = nextParamsForClearFilters(paramsOf("unread=1&c=abc&engagement=archived&group=source"));
    expect(result.has("engagement")).toBe(false);
    expect(result.get("c")).toBe("abc");
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
  });

  it("preserves the chat selection (grouping is purely visual)", () => {
    const result = nextParamsForGroup(paramsOf("c=abc"), "source");
    expect(result.get("c")).toBe("abc");
  });
});
