import { describe, expect, it } from "vitest";
import { docPreviewPathFromHref } from "../doc-preview-links.js";

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
