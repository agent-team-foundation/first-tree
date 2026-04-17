import { describe, expect, it } from "vitest";

import {
  RepoFilter,
  searchScopesFor,
} from "../src/products/breeze/engine/runtime/repo-filter.js";

describe("RepoFilter.parseCsv", () => {
  it("accepts owner/repo and owner/*", () => {
    const f = RepoFilter.parseCsv("agent-team-foundation/*,bingran-you/repo");
    expect(f.owners()).toEqual(["agent-team-foundation"]);
    expect(f.repos()).toEqual(["bingran-you/repo"]);
  });

  it("rejects junk patterns", () => {
    expect(() => RepoFilter.parseCsv("not/a/valid/pattern")).toThrow(
      /invalid repo allow pattern/,
    );
    expect(() => RepoFilter.parseCsv("/*")).toThrow(/invalid repo allow pattern/);
  });

  it("dedupes on parse", () => {
    const f = RepoFilter.parseCsv("o/*,o/*,o/r,o/r");
    expect(f.owners()).toEqual(["o"]);
    expect(f.repos()).toEqual(["o/r"]);
  });

  it("treats empty or whitespace as empty filter", () => {
    expect(RepoFilter.parseCsv("").isEmpty()).toBe(true);
    expect(RepoFilter.parseCsv("  ,  ").isEmpty()).toBe(true);
  });
});

describe("RepoFilter.matchesRepo", () => {
  it("accepts all when empty", () => {
    const f = RepoFilter.empty();
    expect(f.matchesRepo("any/thing")).toBe(true);
  });

  it("matches owner/*", () => {
    const f = RepoFilter.parseCsv("foo/*");
    expect(f.matchesRepo("foo/bar")).toBe(true);
    expect(f.matchesRepo("baz/qux")).toBe(false);
  });

  it("matches exact owner/repo", () => {
    const f = RepoFilter.parseCsv("foo/bar");
    expect(f.matchesRepo("foo/bar")).toBe(true);
    expect(f.matchesRepo("foo/baz")).toBe(false);
  });
});

describe("RepoFilter.merge", () => {
  it("combines owners and repos without dupes", () => {
    const a = RepoFilter.parseCsv("o/*,a/r");
    const b = RepoFilter.parseCsv("p/*,a/r,b/r");
    const merged = a.merge(b);
    expect(merged.owners()).toEqual(["o", "p"]);
    expect(merged.repos()).toEqual(["a/r", "b/r"]);
  });
});

describe("RepoFilter display / cli", () => {
  it("renders patterns joined with comma and space", () => {
    const f = RepoFilter.parseCsv("o/r,p/*");
    expect(f.displayPatterns()).toBe("o/r, p/*");
    expect(f.cliValue()).toBe("o/r,p/*");
  });
});

describe("searchScopesFor", () => {
  it("returns all when filter is empty", () => {
    expect(searchScopesFor(RepoFilter.empty())).toEqual([{ kind: "all" }]);
  });

  it("emits one scope per owner and explicit repo", () => {
    const f = RepoFilter.parseCsv("o/*,p/r");
    const scopes = searchScopesFor(f);
    expect(scopes).toContainEqual({ kind: "owner", owner: "o" });
    expect(scopes).toContainEqual({ kind: "repo", repo: "p/r" });
  });
});
