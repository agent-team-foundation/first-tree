import { describe, expect, it } from "vitest";

import {
  canonicalApiPath,
  decodeMultiline,
  encodeMultiline,
  fnv1a64,
  isRecentGithubTimestamp,
  parseGithubTimestampEpoch,
  parseKvLines,
  parseTsvLine,
  shellQuote,
  stableFileId,
  unescapeJqField,
} from "../src/products/breeze/engine/runtime/task-util.js";

describe("fnv1a64 / stableFileId", () => {
  it("matches known FNV-1a 64 outputs", () => {
    // Reference values (computed via Rust util.rs::fnv1a64).
    expect(fnv1a64("").toString(16)).toBe("cbf29ce484222325");
    expect(fnv1a64("a").toString(16)).toBe("af63dc4c8601ec8c");
    expect(fnv1a64("foobar").toString(16)).toBe("85944171f73967e8");
  });

  it("stableFileId renders zero-padded 16-hex chars", () => {
    expect(stableFileId("")).toBe("cbf29ce484222325");
    expect(stableFileId("foobar")).toHaveLength(16);
  });
});

describe("canonicalApiPath", () => {
  it("strips api.github.com / github.com prefixes + trailing slashes", () => {
    expect(
      canonicalApiPath("https://api.github.com/repos/o/r/pulls/12/"),
    ).toBe("/repos/o/r/pulls/12");
    expect(canonicalApiPath("https://github.com/o/r/pull/3")).toBe(
      "/o/r/pull/3",
    );
    expect(canonicalApiPath("/repos/o/r")).toBe("/repos/o/r");
  });
});

describe("parseTsvLine / unescapeJqField", () => {
  it("splits on tabs and unescapes \\n \\t \\\\", () => {
    const line = "a\\nbc\tdef\\tghi\t\\\\end";
    const fields = parseTsvLine(line);
    expect(fields).toEqual(["a\nbc", "def\tghi", "\\end"]);
  });

  it("decodes \\uXXXX escapes", () => {
    expect(unescapeJqField("\\u0041bc")).toBe("Abc");
  });
});

describe("encodeMultiline / decodeMultiline", () => {
  it("round-trips newlines through the \\n sentinel", () => {
    const original = "line1\nline2\nend";
    const encoded = encodeMultiline(original);
    expect(encoded).toBe("line1\\nline2\\nend");
    expect(decodeMultiline(encoded)).toBe(original);
  });
});

describe("shellQuote", () => {
  it("returns '' for empty", () => {
    expect(shellQuote("")).toBe("''");
  });

  it("passes shell-safe strings through unchanged", () => {
    expect(shellQuote("abc-DEF.123_/:=,@")).toBe("abc-DEF.123_/:=,@");
  });

  it("single-quotes unsafe strings and escapes embedded quotes", () => {
    expect(shellQuote("hello world")).toBe("'hello world'");
    expect(shellQuote("don't")).toBe(`'don'"'"'t'`);
  });
});

describe("parseKvLines", () => {
  it("extracts key/value pairs and skips malformed lines", () => {
    const input = "a=1\nno-equals\nb=two\n  c  =  three\n";
    expect(parseKvLines(input)).toEqual([
      ["a", "1"],
      ["b", "two"],
      ["c", "three"],
    ]);
  });
});

describe("parseGithubTimestampEpoch / isRecentGithubTimestamp", () => {
  it("parses a valid ISO-Z timestamp to unix seconds", () => {
    expect(parseGithubTimestampEpoch("2026-01-02T03:04:05Z")).toBe(
      Date.UTC(2026, 0, 2, 3, 4, 5) / 1000,
    );
  });

  it("rejects wrong length / bad separators / invalid month", () => {
    expect(parseGithubTimestampEpoch("2026-01-02T03:04:05")).toBeUndefined();
    expect(parseGithubTimestampEpoch("2026-13-02T03:04:05Z")).toBeUndefined();
    expect(parseGithubTimestampEpoch("2026-02-30T03:04:05Z")).toBeUndefined();
  });

  it("isRecentGithubTimestamp compares against now - lookback", () => {
    const now = parseGithubTimestampEpoch("2026-04-15T12:00:00Z")!;
    expect(
      isRecentGithubTimestamp("2026-04-15T11:59:00Z", now, 120),
    ).toBe(true);
    expect(
      isRecentGithubTimestamp("2026-04-15T11:57:00Z", now, 120),
    ).toBe(false);
  });
});
