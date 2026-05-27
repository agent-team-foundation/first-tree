import { describe, expect, it } from "vitest";
import { scanBareDocPathTokens, stripDocPathLineSuffix } from "../doc-link-scan.js";

function tokens(text: string): string[] {
  return scanBareDocPathTokens(text).map((m) => m.raw);
}

describe("scanBareDocPathTokens", () => {
  it("picks plain markdown paths with optional line/col suffix", () => {
    expect(tokens("Created docs/intro.md and README.md:12 and docs/api.md:42:13.")).toEqual([
      "docs/intro.md",
      "README.md:12",
      "docs/api.md:42:13",
    ]);
  });

  it("ignores paths already inside markdown links", () => {
    expect(tokens("see [intro](docs/intro.md) for more")).toEqual([]);
  });

  it("picks paths inside single-line inline code spans (single + multi backtick) with enclosingCodeSpan", () => {
    // Phase 1: inline code is no longer a hard skip. The token IS reported,
    // but with the outer-tick span attached so the rewrite can widen the
    // replacement to `[`docs/code.md`](key)` instead of dead inline code.
    const single = scanBareDocPathTokens("Inline `docs/code.md` is literal");
    expect(single.map((m) => m.raw)).toEqual(["docs/code.md"]);
    expect(single[0]?.enclosingCodeSpan).toBeDefined();
    const singleSpan = single[0]?.enclosingCodeSpan;
    if (!singleSpan) throw new Error("expected enclosingCodeSpan");
    // Outer ticks INCLUDED in the span.
    expect("Inline `docs/code.md` is literal".slice(singleSpan.start, singleSpan.end)).toBe("`docs/code.md`");

    const multi = scanBareDocPathTokens("Double ``embedded ` ticks docs/code.md`` is literal");
    expect(multi.map((m) => m.raw)).toEqual(["docs/code.md"]);
    const multiSpan = multi[0]?.enclosingCodeSpan;
    if (!multiSpan) throw new Error("expected enclosingCodeSpan");
    expect("Double ``embedded ` ticks docs/code.md`` is literal".slice(multiSpan.start, multiSpan.end)).toBe(
      "``embedded ` ticks docs/code.md``",
    );
  });

  it("leaves unwrapped tokens without enclosingCodeSpan", () => {
    const matches = scanBareDocPathTokens("see docs/intro.md please");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.enclosingCodeSpan).toBeUndefined();
  });

  it("ignores paths inside fenced code blocks", () => {
    const text = ["```", "docs/fenced.md", "```", "and docs/after.md"].join("\n");
    expect(tokens(text)).toEqual(["docs/after.md"]);
  });

  it("ignores indented (4-space / tab) code blocks", () => {
    expect(tokens("    docs/indented.md")).toEqual([]);
    expect(tokens("\tdocs/tabbed.md")).toEqual([]);
  });

  it("ignores reference link definitions", () => {
    expect(tokens('[ref]: docs/reference.md "title"')).toEqual([]);
  });

  it("ignores paths inside HTML tag bodies (href attributes etc.)", () => {
    expect(tokens('<a href="docs/html.md">link</a>')).toEqual([]);
  });

  it("ignores domain-shaped tokens that look like URLs without a scheme", () => {
    expect(tokens("see example.com/docs/intro.md")).toEqual([]);
  });

  it("does not treat .md as a domain TLD when the first segment ends in .md", () => {
    expect(tokens("See notes.md/follow-up.md")).toEqual(["notes.md/follow-up.md"]);
  });

  it("reports byte offsets that point to the raw token inside the input", () => {
    const text = "Hello docs/intro.md world";
    const matches = scanBareDocPathTokens(text);
    expect(matches).toHaveLength(1);
    const m = matches[0];
    if (!m) throw new Error("expected one match");
    expect(text.slice(m.start, m.end)).toBe("docs/intro.md");
  });
});

describe("stripDocPathLineSuffix", () => {
  it("returns the path unchanged when no line suffix is present", () => {
    expect(stripDocPathLineSuffix("docs/intro.md")).toBe("docs/intro.md");
  });

  it("drops :line and :line:col suffixes", () => {
    expect(stripDocPathLineSuffix("docs/intro.md:12")).toBe("docs/intro.md");
    expect(stripDocPathLineSuffix("docs/api.md:42:13")).toBe("docs/api.md");
  });
});
