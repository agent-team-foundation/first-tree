import { describe, expect, it } from "vitest";
import { stripInlineMarkdown } from "../strip-inline-markdown.js";

describe("stripInlineMarkdown — peel inline markers off a one-line preview", () => {
  it("drops inline-code backticks but keeps the contents", () => {
    expect(stripInlineMarkdown("looking at `issue 669` now")).toBe("looking at issue 669 now");
  });

  it("strips bold and italic markers", () => {
    expect(stripInlineMarkdown("this is **done** and *ready*")).toBe("this is done and ready");
    expect(stripInlineMarkdown("__bold__ then _slanted_ words")).toBe("bold then slanted words");
  });

  it("keeps a link's label, drops the url", () => {
    expect(stripInlineMarkdown("see [the PR](https://example.com/x) for details")).toBe("see the PR for details");
  });

  it("leaves underscores inside identifiers intact", () => {
    expect(stripInlineMarkdown("editing foo_bar_baz.ts")).toBe("editing foo_bar_baz.ts");
  });

  it("never leaves a bare backtick behind", () => {
    expect(stripInlineMarkdown("an unbalanced ` tick")).not.toContain("`");
    expect(stripInlineMarkdown("trailing tick`")).toBe("trailing tick");
  });

  it("is a no-op for plain prose", () => {
    expect(stripInlineMarkdown("just fixing the status bar")).toBe("just fixing the status bar");
  });
});
