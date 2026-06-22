import { describe, expect, it } from "vitest";
import { descriptionFirstLine } from "../task-header.js";

/**
 * `descriptionFirstLine` powers the collapsed task-header bar: it picks the
 * first line of the chat description with real content and strips the common
 * markdown markers so a `## Heading` or `- bullet` reads as plain text (visual
 * truncation is left to CSS). It must degrade gracefully past structural-only
 * lines.
 */
describe("descriptionFirstLine", () => {
  it("strips a leading heading marker", () => {
    expect(descriptionFirstLine("## Goals\nbody")).toBe("Goals");
  });

  it("strips a leading bullet", () => {
    expect(descriptionFirstLine("- first item")).toBe("first item");
  });

  it("strips an ordered-list marker", () => {
    expect(descriptionFirstLine("1. step one")).toBe("step one");
  });

  it("strips inline emphasis and inline code", () => {
    expect(descriptionFirstLine("**Status**: `done` soon")).toBe("Status: done soon");
  });

  it("renders a link as its text", () => {
    expect(descriptionFirstLine("see [the PR](https://x/y) now")).toBe("see the PR now");
  });

  it("strips a blockquote marker", () => {
    expect(descriptionFirstLine("> quoted line")).toBe("quoted line");
  });

  it("skips blank lines and uses the first line with content", () => {
    expect(descriptionFirstLine("\n   \nReal first line")).toBe("Real first line");
  });

  it("skips a leading thematic break / horizontal rule", () => {
    expect(descriptionFirstLine("---\nAfter the rule")).toBe("After the rule");
  });

  it("skips a table delimiter row but keeps the header row", () => {
    expect(descriptionFirstLine("| Col A | Col B |\n| --- | --- |")).toBe("Col A | Col B |");
  });

  it("collapses internal whitespace", () => {
    expect(descriptionFirstLine("a    b\tc")).toBe("a b c");
  });

  it("returns an empty string for an all-whitespace description", () => {
    expect(descriptionFirstLine("   \n\n  ")).toBe("");
  });
});
