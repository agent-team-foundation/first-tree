import { describe, expect, it } from "vitest";
import {
  buildFailedDocHref,
  docPreviewPathFromHref,
  linkifyMarkdownDocPaths,
  parseFailedDocHref,
  wrapFailedDocMentions,
} from "../doc-preview-links.js";

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

  it("does not touch already-linked paths, fenced code, HTML tags, or external URLs", () => {
    // Phase 1: inline code is NOT in this list anymore — see the dedicated
    // code-span test below. Fenced / HTML / inline-link / domain-shaped are
    // still hard skips.
    const input = [
      "Already [intro](docs/intro.md)",
      'HTML <a href="docs/html.md">link</a>',
      "```",
      "docs/fenced.md",
      "```",
      "External https://example.com/readme.md",
      "Text docs/readme.txt",
    ].join("\n");
    // Even when the snapshot set contains these paths, the scanner skips
    // links / code / HTML, so the source is returned unchanged.
    expect(linkifyMarkdownDocPaths(input, new Set(["docs/intro.md", "docs/fenced.md", "docs/html.md"]))).toBe(input);
  });

  it("widens the rewrite to a code-span-wrapped path, preserving the mono-spaced visual", () => {
    // Legacy (pre-runtime-rewrite) message where the agent wrapped the path
    // in single backticks. Web's fallback now mirrors the runtime: enclose
    // the whole `` `…` `` span as the link text so the chip renders as
    // code-styled monospace AND becomes clickable.
    expect(linkifyMarkdownDocPaths("see `docs/intro.md` please", new Set(["docs/intro.md"]))).toBe(
      "see [`docs/intro.md`](docs/intro.md) please",
    );
  });

  it("preserves multi-backtick code-span wrappers verbatim in the legacy fallback", () => {
    expect(linkifyMarkdownDocPaths("see ``the ` token in docs/intro.md`` after", new Set(["docs/intro.md"]))).toBe(
      "see [``the ` token in docs/intro.md``](docs/intro.md) after",
    );
  });

  it("leaves a code-span-wrapped path without a snapshot as plain text", () => {
    // Same invariant as bare tokens — no dead links. If the path isn't in
    // `snapshotPaths` the code span stays untouched.
    expect(linkifyMarkdownDocPaths("see `docs/intro.md` please", new Set())).toBe("see `docs/intro.md` please");
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

describe("buildFailedDocHref / parseFailedDocHref", () => {
  it("round-trips every well-known reason", () => {
    for (const reason of [
      "missing",
      "out-of-fence",
      "hidden-segment",
      "too-large",
      "budget-exceeded",
      "unreadable",
    ] as const) {
      const href = buildFailedDocHref(reason);
      expect(parseFailedDocHref(href)).toBe(reason);
    }
  });

  it("returns null for hrefs that aren't ours", () => {
    expect(parseFailedDocHref("docs/intro.md")).toBeNull();
    expect(parseFailedDocHref("#heading")).toBeNull();
    expect(parseFailedDocHref("#doc-failed")).toBeNull();
    expect(parseFailedDocHref("https://example.com/?reason=missing")).toBeNull();
  });

  it("returns null when the embedded reason isn't a known enum value", () => {
    // Defensive: a malformed reason renders as plain link, never a crash.
    expect(parseFailedDocHref("#doc-failed?reason=banana")).toBeNull();
    expect(parseFailedDocHref("#doc-failed?reason=")).toBeNull();
  });
});

describe("wrapFailedDocMentions", () => {
  it("wraps a bare failed mention into the inert-chip placeholder link", () => {
    // The wrap pass converts `docs/missing.md` into `[docs/missing.md](#doc-failed?reason=missing)`
    // so the chat-view's `a` override renders it as a disabled chip — failure
    // becomes visible instead of silently degrading to plain text.
    expect(wrapFailedDocMentions("see docs/missing.md please", new Map([["docs/missing.md", "missing"]]))).toBe(
      "see [docs/missing.md](#doc-failed?reason=missing) please",
    );
  });

  it("widens to the whole code span when the failed mention sits inside backticks", () => {
    // Phase-1 scanner reports the enclosingCodeSpan; the wrap pass uses it to
    // keep the mono-spaced visual on the disabled chip.
    expect(wrapFailedDocMentions("see `docs/missing.md` please", new Map([["docs/missing.md", "missing"]]))).toBe(
      "see [`docs/missing.md`](#doc-failed?reason=missing) please",
    );
  });

  it("matches `docs/foo.md:42` to a `docs/foo.md` entry by stripping the line suffix", () => {
    // Wire format stores the suffix-stripped writtenPath; the wrapper
    // canonicalises each scan match before lookup so all variants render the
    // same chip.
    expect(wrapFailedDocMentions("open docs/missing.md:42 here", new Map([["docs/missing.md", "missing"]]))).toBe(
      "open [docs/missing.md:42](#doc-failed?reason=missing) here",
    );
  });

  it("leaves tokens whose raw isn't in the failed map as plain text", () => {
    // Co-existing real and failed mentions: the runtime would already have
    // linkified the real one before this pass runs in chat-view, so here we
    // verify the wrap pass leaves unmatched bare tokens alone.
    expect(
      wrapFailedDocMentions("see docs/intro.md and docs/missing.md", new Map([["docs/missing.md", "missing"]])),
    ).toBe("see docs/intro.md and [docs/missing.md](#doc-failed?reason=missing)");
  });

  it("no-ops on an empty failed map", () => {
    expect(wrapFailedDocMentions("see docs/intro.md", new Map())).toBe("see docs/intro.md");
  });

  it("emits distinct reasons across multiple failed mentions in one message", () => {
    expect(
      wrapFailedDocMentions(
        "missing docs/a.md and oversize docs/b.md",
        new Map<string, "missing" | "too-large">([
          ["docs/a.md", "missing"],
          ["docs/b.md", "too-large"],
        ]),
      ),
    ).toBe("missing [docs/a.md](#doc-failed?reason=missing) and oversize [docs/b.md](#doc-failed?reason=too-large)");
  });

  it("emits a link text containing `[` and `]` that CommonMark still parses correctly (regression)", () => {
    // An agent code-span that contains BOTH brackets AND a path produces
    // `[`see [v2] docs/foo.md`](docs/foo.md)`. Round-2 review flagged this as
    // potential malformed markdown; CommonMark §6.3 + §6.6 explicitly allow
    // brackets inside code spans within link text — verified via the
    // mdast-util-from-markdown parser. This test pins the output shape so a
    // future refactor that "fixes" the verbatim slice doesn't quietly break
    // this perfectly valid input.
    expect(
      wrapFailedDocMentions("see `before [v2] docs/missing.md after`", new Map([["docs/missing.md", "missing"]])),
    ).toBe("see [`before [v2] docs/missing.md after`](#doc-failed?reason=missing)");
  });
});
