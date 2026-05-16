import { describe, expect, it } from "vitest";
import { docPreviewPathFromHref, linkifyMarkdownDocPaths } from "../doc-preview-links.js";

describe("docPreviewPathFromHref", () => {
  it("accepts markdown paths and strips query/hash fragments", () => {
    expect(docPreviewPathFromHref("docs/design.md?plain=1#section")).toBe("docs/design.md");
  });

  it("resolves relative links against the current document path", () => {
    expect(docPreviewPathFromHref("../api.md", "docs/design/overview.md")).toBe("docs/api.md");
    expect(docPreviewPathFromHref("../api.md:12", { currentDocPath: "docs/design/overview.md" })).toBe("docs/api.md");
  });

  it("normalizes root-relative markdown paths inside the preview root", () => {
    expect(docPreviewPathFromHref("/docs/intro.md")).toBe("docs/intro.md");
  });

  it("accepts generated markdown file links with line suffixes", () => {
    expect(docPreviewPathFromHref("README.md:12")).toBe("README.md");
    expect(docPreviewPathFromHref("docs/intro.md:12:4")).toBe("docs/intro.md");
  });

  it("strips repo-local base path from absolute workspace links", () => {
    expect(
      docPreviewPathFromHref(
        "/Users/gandy/.first-tree/hub/data/workspaces/coder/chat-1/first-tree-hub/docs/intro.md:7",
        {
          basePath: "first-tree-hub",
        },
      ),
    ).toBe("docs/intro.md");
  });

  it("rejects paths that escape above the preview root", () => {
    expect(docPreviewPathFromHref("../../../secret.md", "docs/design/overview.md")).toBeNull();
    expect(docPreviewPathFromHref("../secret.md")).toBeNull();
  });

  it("rejects schemes, scheme-relative links, fragments, and non-markdown links", () => {
    expect(docPreviewPathFromHref("https://example.com/readme.md")).toBeNull();
    expect(docPreviewPathFromHref("mailto:hello@example.com")).toBeNull();
    expect(docPreviewPathFromHref("//example.com/readme.md")).toBeNull();
    expect(docPreviewPathFromHref("#heading")).toBeNull();
    expect(docPreviewPathFromHref("docs/readme.txt")).toBeNull();
  });
});

describe("linkifyMarkdownDocPaths", () => {
  it("links plain markdown document paths in chat text", () => {
    expect(linkifyMarkdownDocPaths("Created docs/intro.md, README.md:12, and docs/api.md:42:13.")).toBe(
      "Created [docs/intro.md](docs/intro.md), [README.md:12](README.md:12), and [docs/api.md:42:13](docs/api.md:42:13).",
    );
  });

  it("links repo-local absolute paths when a base path is available", () => {
    const path = "/Users/gandy/.first-tree/hub/data/workspaces/coder/chat-1/first-tree-hub/docs/intro.md:7";
    expect(linkifyMarkdownDocPaths(`Created ${path}`, { basePath: "first-tree-hub" })).toBe(
      `Created [${path}](${path})`,
    );
  });

  it("does not rewrite existing links, inline code, fenced code, external urls, or non-markdown paths", () => {
    expect(
      linkifyMarkdownDocPaths(
        [
          "Already [intro](docs/intro.md)",
          "Inline `docs/code.md`",
          'HTML <a href="docs/html.md">link</a>',
          '[ref]: docs/reference.md "Reference"',
          "    docs/indented.md",
          "```",
          "docs/fenced.md",
          "```",
          "External https://example.com/readme.md",
          "Text docs/readme.txt",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Already [intro](docs/intro.md)",
        "Inline `docs/code.md`",
        'HTML <a href="docs/html.md">link</a>',
        '[ref]: docs/reference.md "Reference"',
        "    docs/indented.md",
        "```",
        "docs/fenced.md",
        "```",
        "External https://example.com/readme.md",
        "Text docs/readme.txt",
      ].join("\n"),
    );
  });

  it("does not treat markdown-named directories as domains", () => {
    expect(linkifyMarkdownDocPaths("See notes.md/follow-up.md")).toBe(
      "See [notes.md/follow-up.md](notes.md/follow-up.md)",
    );
  });
});
