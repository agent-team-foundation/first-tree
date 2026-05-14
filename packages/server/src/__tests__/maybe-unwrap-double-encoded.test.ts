import { describe, expect, it } from "vitest";
import { maybeUnwrapDoubleEncoded } from "../services/message.js";

/**
 * Pins the issue-#389 defensive unwrap. Agents occasionally `JSON.stringify`
 * a string before passing it to `chat send` (a leftover from function-calling
 * habits where tool arguments are JSON-encoded). The result is a literal
 * `"@x ...\n..."` row in the DB that the UI renders as a quoted line with
 * literal `\n` instead of markdown.
 *
 * The unwrap is intentionally STRICT: it only triggers on the exact shape an
 * accidental double-encode produces, so quoted phrases written by humans —
 * or any string that merely starts with `"` — are left alone. The caller in
 * `sendMessage` further restricts this to non-human senders; these cases
 * exercise only the structural matcher.
 */
describe("maybeUnwrapDoubleEncoded", () => {
  it("unwraps a JSON-encoded string with interior \\n escapes", () => {
    const wrapped = JSON.stringify("@bob hello\n\nline two");
    expect(maybeUnwrapDoubleEncoded(wrapped)).toBe("@bob hello\n\nline two");
  });

  it('unwraps a JSON-encoded string with interior \\" escapes', () => {
    const wrapped = JSON.stringify('she said "hi"\nthen left');
    expect(maybeUnwrapDoubleEncoded(wrapped)).toBe('she said "hi"\nthen left');
  });

  it("leaves human quoted phrases alone — no escape sequences inside", () => {
    expect(maybeUnwrapDoubleEncoded('"this is a quote"')).toBeNull();
    expect(maybeUnwrapDoubleEncoded('"hello"')).toBeNull();
  });

  it("leaves plain text alone", () => {
    expect(maybeUnwrapDoubleEncoded("hello world")).toBeNull();
    expect(maybeUnwrapDoubleEncoded("@bob\nthis is fine")).toBeNull();
  });

  it("leaves single-quoted-looking but not JSON content alone", () => {
    // missing trailing quote
    expect(maybeUnwrapDoubleEncoded('"unterminated\\n')).toBeNull();
    // outer single quotes, not double
    expect(maybeUnwrapDoubleEncoded("'@bob\\nhi'")).toBeNull();
  });

  it("leaves JSON-encoded non-strings alone (objects, arrays, numbers)", () => {
    expect(maybeUnwrapDoubleEncoded('{"key":"value"}')).toBeNull();
    expect(maybeUnwrapDoubleEncoded("[1,2,3]")).toBeNull();
    expect(maybeUnwrapDoubleEncoded("42")).toBeNull();
  });

  it("rejects too-short inputs", () => {
    expect(maybeUnwrapDoubleEncoded("")).toBeNull();
    expect(maybeUnwrapDoubleEncoded('""')).toBeNull();
    expect(maybeUnwrapDoubleEncoded('"a"')).toBeNull();
  });

  it("handles realistic agent double-encode from the issue", () => {
    // The exact shape called out in issue #389: outer quotes + literal \n
    // between markdown paragraphs.
    const wrapped = '"@somebody ✅ Task done — https://...\\n\\nfollow-up...\\n\\n1. step\\n2. step\\n"';
    const out = maybeUnwrapDoubleEncoded(wrapped);
    expect(out).not.toBeNull();
    expect(out).toContain("@somebody");
    expect(out).toContain("\n\n");
    expect(out).not.toContain("\\n");
  });
});
