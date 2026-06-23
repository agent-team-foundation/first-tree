import { describe, expect, it } from "vitest";
import { descriptionFirstLine } from "../task-summary.js";

/**
 * `descriptionFirstLine` powers the collapsed task-summary bar: it picks the
 * first content line of the chat description and strips the common markdown
 * markers so a `- bullet` reads as plain text (visual truncation is left to
 * CSS). A leading section heading (`## 任务`) is skipped in favor of the prose
 * below it, falling back to the heading only when there is nothing else. It
 * must also degrade gracefully past structural-only lines.
 */
describe("descriptionFirstLine", () => {
  it("prefers the first content line over a leading section heading", () => {
    expect(descriptionFirstLine("## Goals\nbody")).toBe("body");
  });

  it("degrades a section-label heading to the prose below it", () => {
    expect(descriptionFirstLine("## 任务\n把右侧 summary 改为任务头")).toBe("把右侧 summary 改为任务头");
  });

  it("skips multiple stacked headings to reach the prose", () => {
    expect(descriptionFirstLine("# Title\n## Section\nThe real summary")).toBe("The real summary");
  });

  it("falls back to the heading when the description is only heading(s)", () => {
    expect(descriptionFirstLine("# Just a title")).toBe("Just a title");
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

  it("preserves literal underscores in content (snake_case identifiers are not mangled)", () => {
    expect(descriptionFirstLine("- `description_updated_at` lands")).toBe("description_updated_at lands");
  });

  it("strips emphasis markers but keeps an underscored identifier inside them", () => {
    expect(descriptionFirstLine("**foo_bar_baz** done")).toBe("foo_bar_baz done");
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
