import { describe, expect, it } from "vitest";
import { docPreviewPathFromHref, linkifyMarkdownDocPaths } from "../doc-preview-links.js";

describe("docPreviewPathFromHref", () => {
  it("accepts markdown paths with `:line[:col]` suffix and strips them", () => {
    expect(docPreviewPathFromHref("docs/intro.md:12")).toBe("docs/intro.md");
    expect(docPreviewPathFromHref("docs/api.md:42:13")).toBe("docs/api.md");
  });

  it("accepts markdown paths and strips query/hash fragments", () => {
    expect(docPreviewPathFromHref("docs/design.md?plain=1#section")).toBe("docs/design.md");
  });

  it("resolves relative links against the current document path", () => {
    expect(docPreviewPathFromHref("../api.md", "docs/design/overview.md")).toBe("docs/api.md");
  });

  it("normalizes root-relative markdown paths inside the preview root", () => {
    expect(docPreviewPathFromHref("/docs/intro.md")).toBe("docs/intro.md");
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

  it("rejects hidden segments (.dotfile / .agent / .git) so a click never resolves into them", () => {
    expect(docPreviewPathFromHref(".agent/secret.md")).toBeNull();
    expect(docPreviewPathFromHref("docs/.hidden.md")).toBeNull();
    expect(docPreviewPathFromHref("docs/.git/HEAD.md")).toBeNull();
  });
});

describe("linkifyMarkdownDocPaths", () => {
  it("wraps only snapshotted paths, linking to the canonical (de-suffixed) target", () => {
    // `README.md:12` keeps its `:12` in the visible text but links to the
    // canonical `README.md` — an href with a `:` before any `/` would be
    // stripped to "" by react-markdown's defaultUrlTransform and reload the page.
    expect(
      linkifyMarkdownDocPaths("Created docs/intro.md and README.md:12.", new Set(["docs/intro.md", "README.md"])),
    ).toBe("Created [docs/intro.md](docs/intro.md) and [README.md:12](README.md).");
  });

  it("leaves a mentioned-but-not-snapshotted path as plain text (no dead links)", () => {
    // The agent only *talks about* README.md:12 (e.g. describing a bug); there
    // is no snapshot for it, so it must NOT become a clickable (dead) link.
    expect(linkifyMarkdownDocPaths("the README.md:12 bug is annoying", new Set())).toBe(
      "the README.md:12 bug is annoying",
    );
    expect(linkifyMarkdownDocPaths("see docs/intro.md for details", new Set(["docs/other.md"]))).toBe(
      "see docs/intro.md for details",
    );
  });

  it("does not touch already-linked paths, inline code, fenced code, HTML tags, or external URLs", () => {
    const input = [
      "Already [intro](docs/intro.md)",
      "Inline `docs/code.md`",
      'HTML <a href="docs/html.md">link</a>',
      "```",
      "docs/fenced.md",
      "```",
      "External https://example.com/readme.md",
      "Text docs/readme.txt",
    ].join("\n");
    // Even when the snapshot set contains these paths, the scanner skips
    // links / code / HTML, so the source is returned unchanged.
    expect(
      linkifyMarkdownDocPaths(input, new Set(["docs/intro.md", "docs/code.md", "docs/fenced.md", "docs/html.md"])),
    ).toBe(input);
  });

  it("returns the source unchanged when no plain markdown paths are present", () => {
    const text = "hello world";
    expect(linkifyMarkdownDocPaths(text, new Set(["docs/intro.md"]))).toBe(text);
  });

  it("leaves tokens that would canonicalise to null as plain text (hidden segments, escapes)", () => {
    // These match the surface-level regex but `normalizeDocLinkPath` rejects
    // them, so they can never be in the snapshot set and stay plain text.
    const input = "see .agent/secret.md and ../outside.md and docs/.git/HEAD.md";
    expect(linkifyMarkdownDocPaths(input, new Set([".agent/secret.md", "outside.md"]))).toBe(input);
  });

  it("linkifies the snapshotted token in a line that also contains an unresolvable one", () => {
    expect(linkifyMarkdownDocPaths("ok docs/intro.md but not .agent/secret.md", new Set(["docs/intro.md"]))).toBe(
      "ok [docs/intro.md](docs/intro.md) but not .agent/secret.md",
    );
  });

  it("expands a short cross-agent token to the global key when a chatId is given", () => {
    // Runtime rewrote a sibling-workspace mention to `assistant/design.md` and
    // embedded the snapshot under the global key `assistant/<chatId>/design.md`.
    // Web re-expands the token with the current chat id and links to that key.
    expect(linkifyMarkdownDocPaths("see assistant/design.md", new Set(["assistant/chat-1/design.md"]), "chat-1")).toBe(
      "see [assistant/design.md](assistant/chat-1/design.md)",
    );
  });

  it("prefers a direct (self/legacy) bare key over the cross expansion", () => {
    // A literal self subdir named like another agent still matches its bare key
    // first, so self previews never get hijacked by cross expansion.
    expect(linkifyMarkdownDocPaths("see assistant/design.md", new Set(["assistant/design.md"]), "chat-1")).toBe(
      "see [assistant/design.md](assistant/design.md)",
    );
  });

  it("does not cross-expand without a chatId (self-only matching)", () => {
    expect(linkifyMarkdownDocPaths("see assistant/design.md", new Set(["assistant/chat-1/design.md"]))).toBe(
      "see assistant/design.md",
    );
  });

  it("leaves a cross token plain when its expanded global key isn't snapshotted", () => {
    expect(linkifyMarkdownDocPaths("see assistant/design.md", new Set(["assistant/chat-1/other.md"]), "chat-1")).toBe(
      "see assistant/design.md",
    );
  });

  it("disambiguates a self/cross collision: self short token vs full cross key (P2-b)", () => {
    // Runtime emits the FULL global key for the colliding cross mention, so the
    // bare `assistant/design.md` token is unambiguously the SELF snapshot and
    // the full-key token resolves to the cross snapshot — distinct targets.
    const set = new Set(["assistant/design.md", "assistant/chat-1/design.md"]);
    expect(
      linkifyMarkdownDocPaths("self assistant/design.md and cross assistant/chat-1/design.md", set, "chat-1"),
    ).toBe(
      "self [assistant/design.md](assistant/design.md) and cross [assistant/chat-1/design.md](assistant/chat-1/design.md)",
    );
  });
});
