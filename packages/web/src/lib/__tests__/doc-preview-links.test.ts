import { describe, expect, it } from "vitest";
import {
  attachmentIdFromHref,
  buildFailedDocHref,
  parseFailedDocHref,
  wrapFailedDocMentions,
} from "../doc-preview-links.js";

describe("attachmentIdFromHref", () => {
  const UUID = "00000000-0000-4000-8000-000000000001";

  it("extracts a uuid attachment id from an `attachment:<uuid>` href", () => {
    expect(attachmentIdFromHref(`attachment:${UUID}`)).toBe(UUID);
  });

  it("strips any query/hash suffix defensively", () => {
    expect(attachmentIdFromHref(`attachment:${UUID}?x=1`)).toBe(UUID);
    expect(attachmentIdFromHref(`attachment:${UUID}#frag`)).toBe(UUID);
  });

  it("returns null for a non-attachment href", () => {
    expect(attachmentIdFromHref("docs/intro.md")).toBeNull();
    expect(attachmentIdFromHref("https://example.com/x.md")).toBeNull();
    expect(attachmentIdFromHref("#heading")).toBeNull();
  });

  it("returns null when the id isn't uuid-shaped", () => {
    expect(attachmentIdFromHref("attachment:not-a-uuid")).toBeNull();
    expect(attachmentIdFromHref("attachment:")).toBeNull();
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
