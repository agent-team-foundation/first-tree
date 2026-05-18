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

  it("ignores paths inside inline code spans (single + multi backtick)", () => {
    expect(tokens("Inline `docs/code.md` is literal")).toEqual([]);
    expect(tokens("Double ``code with ` inside docs/code.md`` is literal")).toEqual([]);
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
