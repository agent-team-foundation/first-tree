import { describe, expect, it } from "vitest";
import { looksLikeHeredocResidueBody, looksLikeJsonWrappedBody } from "../commands/chat/_shared/io.js";

/**
 * Pins the inline `chat send` / `chat ask` shell-residue guards. When a model
 * composes a body through a heredoc or `JSON.stringify` and the shell collapses
 * it, the CLI receives a recognisable wreck — a bare `@EOF` delimiter (the
 * reported screenshot) or a quote-wrapped `"...\n..."` row. These predicates
 * reject exactly those shapes BEFORE anything is sent, while leaving real
 * messages — including ones that merely mention `<<EOF` / `@EOF` — sendable.
 */
describe("looksLikeHeredocResidueBody", () => {
  it("matches the screenshot shape — a lone @-prefixed delimiter", () => {
    expect(looksLikeHeredocResidueBody("@EOF")).toBe(true);
    expect(looksLikeHeredocResidueBody("  @EOF  ")).toBe(true);
  });

  it("matches bare common terminators, case-insensitively", () => {
    expect(looksLikeHeredocResidueBody("EOF")).toBe(true);
    expect(looksLikeHeredocResidueBody("eof")).toBe(true);
    expect(looksLikeHeredocResidueBody("EOT")).toBe(true);
    expect(looksLikeHeredocResidueBody("HEREDOC")).toBe(true);
  });

  it("matches a leaked heredoc opener line", () => {
    expect(looksLikeHeredocResidueBody("<<EOF")).toBe(true);
    expect(looksLikeHeredocResidueBody("<<-'END'")).toBe(true);
    expect(looksLikeHeredocResidueBody("<< END")).toBe(true);
  });

  it("leaves a real message that merely mentions a delimiter alone", () => {
    // qa's adversarial smoke body carries <<EOF / @EOF as tokens — must send.
    expect(looksLikeHeredocResidueBody("heredoc-like text: <<EOF and @EOF here")).toBe(false);
    expect(looksLikeHeredocResidueBody("the heredoc terminator EOF goes on its own line")).toBe(false);
  });

  it("leaves short legitimate all-caps replies alone", () => {
    for (const ok of ["OK", "LGTM", "DONE", "WIP", "TODO", "FYI", "END."]) {
      expect(looksLikeHeredocResidueBody(ok)).toBe(false);
    }
  });

  it("does not match empty / whitespace", () => {
    expect(looksLikeHeredocResidueBody("")).toBe(false);
    expect(looksLikeHeredocResidueBody("   ")).toBe(false);
  });
});

describe("looksLikeJsonWrappedBody", () => {
  it("matches a JSON.stringify wrapper with a single escaped newline", () => {
    expect(looksLikeJsonWrappedBody('"@x line1\\nline2"')).toBe(true);
    expect(looksLikeJsonWrappedBody('  "@alice ping\\nthanks"  ')).toBe(true);
  });

  it("leaves a plain quoted phrase (no escaped newline) alone", () => {
    expect(looksLikeJsonWrappedBody('"hello world"')).toBe(false);
    expect(looksLikeJsonWrappedBody('he said "hi" then left')).toBe(false);
  });

  it("leaves a real-newline body alone — that arrived intact", () => {
    expect(looksLikeJsonWrappedBody('"line1\nline2"')).toBe(false);
  });

  it("leaves an unquoted body alone", () => {
    expect(looksLikeJsonWrappedBody("line1\\nline2")).toBe(false);
  });
});
