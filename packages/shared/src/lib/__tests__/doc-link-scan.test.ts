import { describe, expect, it, vi } from "vitest";
import { markdownCodeSpanRanges, scanBareDocPathTokens, stripDocPathLineSuffix } from "../doc-link-scan.js";

function tokens(text: string): string[] {
  return scanBareDocPathTokens(text).map((m) => m.raw);
}

describe("scanBareDocPathTokens", () => {
  it("picks plain markdown paths with optional line/col suffix", () => {
    expect(tokens("Created docs/intro.md and README.md:12 and docs/api.md:42:13.")).toEqual([
      "docs/intro.md",
      "README.md:12",
      "docs/api.md:42:13",
    ]);
  });

  it("ignores paths already inside markdown links", () => {
    expect(tokens("see [intro](docs/intro.md) for more")).toEqual([]);
  });

  it("picks paths inside single-line inline code spans (single + multi backtick) with enclosingCodeSpan", () => {
    // Phase 1: inline code is no longer a hard skip. The token IS reported,
    // but with the outer-tick span attached so the rewrite can widen the
    // replacement to `[`docs/code.md`](key)` instead of dead inline code.
    const single = scanBareDocPathTokens("Inline `docs/code.md` is literal");
    expect(single.map((m) => m.raw)).toEqual(["docs/code.md"]);
    expect(single[0]?.enclosingCodeSpan).toBeDefined();
    const singleSpan = single[0]?.enclosingCodeSpan;
    if (!singleSpan) throw new Error("expected enclosingCodeSpan");
    // Outer ticks INCLUDED in the span.
    expect("Inline `docs/code.md` is literal".slice(singleSpan.start, singleSpan.end)).toBe("`docs/code.md`");

    const multi = scanBareDocPathTokens("Double ``embedded ` ticks docs/code.md`` is literal");
    expect(multi.map((m) => m.raw)).toEqual(["docs/code.md"]);
    const multiSpan = multi[0]?.enclosingCodeSpan;
    if (!multiSpan) throw new Error("expected enclosingCodeSpan");
    expect("Double ``embedded ` ticks docs/code.md`` is literal".slice(multiSpan.start, multiSpan.end)).toBe(
      "``embedded ` ticks docs/code.md``",
    );
  });

  it("leaves unwrapped tokens without enclosingCodeSpan", () => {
    const matches = scanBareDocPathTokens("see docs/intro.md please");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.enclosingCodeSpan).toBeUndefined();
  });

  it("treats unclosed backtick runs as plain text", () => {
    expect(tokens("See `docs/unclosed.md")).toEqual(["docs/unclosed.md"]);
  });

  it("ignores paths inside fenced code blocks", () => {
    const text = ["```", "docs/fenced.md", "```", "and docs/after.md"].join("\n");
    expect(tokens(text)).toEqual(["docs/after.md"]);
  });

  it("does not close a longer backtick fence on a shorter nested marker", () => {
    const text = [
      "To open a code block, type:",
      "",
      "````",
      "```",
      "````",
      "",
      "Project layout:",
      "",
      "```",
      "repo/",
      "├── NODE.md",
      "├── docs/setup.md",
      "└── sub/",
      "    └── NODE.md",
      "```",
      "",
      "See `README.md` for details.",
    ].join("\n");

    expect(tokens(text)).toEqual(["README.md"]);
  });

  it("treats an unclosed fence as code through the end of the input", () => {
    const text = ["Before README.md", "```", "docs/fenced.md", "After docs/after.md"].join("\n");
    expect(tokens(text)).toEqual(["README.md"]);
  });

  it("requires closing fences to use the opening marker character and minimum length", () => {
    const text = [
      "````",
      "docs/fenced.md",
      "~~~",
      "docs/still-fenced.md",
      "```",
      "docs/also-fenced.md",
      "````",
      "docs/after.md",
    ].join("\n");
    expect(tokens(text)).toEqual(["docs/after.md"]);
  });

  it("supports tilde-opened fences and does not close them on backtick markers", () => {
    const text = ["~~~", "docs/fenced.md", "```", "docs/still-fenced.md", "~~~", "docs/after.md"].join("\n");
    expect(tokens(text)).toEqual(["docs/after.md"]);
  });

  it("recognizes opening fences indented up to three spaces", () => {
    const text = ["   ```", "docs/fenced.md", "   ```", "docs/after.md"].join("\n");
    expect(tokens(text)).toEqual(["docs/after.md"]);
  });

  it("treats a four-space fence marker as indented code, not a fence opener", () => {
    const text = ["    ```", "docs/after.md"].join("\n");
    expect(tokens(text)).toEqual(["docs/after.md"]);
  });

  it("skips fenced blocks whose opening fence carries an info string", () => {
    const text = ["```ts", 'const doc = "docs/fenced.md";', "```", "docs/after.md"].join("\n");
    expect(tokens(text)).toEqual(["docs/after.md"]);
  });

  it("does not treat a backtick fence line with backticks after the marker as an opener", () => {
    // CommonMark: a backtick-fence info string may not contain backticks, so
    // this line renders as a paragraph with inline code, not a code block.
    const text = ["```pnpm test``` runs the suite", "docs/after.md"].join("\n");
    expect(tokens(text)).toEqual(["docs/after.md"]);
  });

  it("keeps real fences skipped after a backtick-containing pseudo-fence line", () => {
    const text = ["```docs/inline.md``` as inline code", "```", "docs/fenced.md", "```", "docs/after.md"].join("\n");
    const matches = scanBareDocPathTokens(text);
    expect(matches.map((m) => m.raw)).toEqual(["docs/inline.md", "docs/after.md"]);
    expect(matches[0]?.enclosingCodeSpan).toBeDefined();
  });

  it("allows backticks in a tilde fence info string", () => {
    const text = ["~~~ `note`", "docs/fenced.md", "~~~", "docs/after.md"].join("\n");
    expect(tokens(text)).toEqual(["docs/after.md"]);
  });

  it("ignores indented (4-space / tab) code blocks", () => {
    expect(tokens("    docs/indented.md")).toEqual([]);
    expect(tokens("\tdocs/tabbed.md")).toEqual([]);
  });

  it("ignores reference link definitions", () => {
    expect(tokens('[ref]: docs/reference.md "title"')).toEqual([]);
  });

  it("ignores paths inside HTML tag bodies (href attributes etc.)", () => {
    expect(tokens('<a href="docs/html.md">link</a>')).toEqual([]);
  });

  it("ignores domain-shaped tokens that look like URLs without a scheme", () => {
    expect(tokens("see example.com/docs/intro.md")).toEqual([]);
  });

  it("does not treat .md as a domain TLD when the first segment ends in .md", () => {
    expect(tokens("See notes.md/follow-up.md")).toEqual(["notes.md/follow-up.md"]);
  });

  it("keeps paths when the domain-like first-segment fallback is empty", () => {
    const originalSplit = String.prototype.split;
    const split = vi.spyOn(String.prototype, "split").mockImplementation(function (this: string, separator, limit) {
      const separatorValue: unknown = separator;
      if (this === "docs/intro.md" && separatorValue === "/" && limit === 1) return [];
      // Type assertion: this defensive branch simulates a hostile split result
      // while preserving String.prototype.split's overloaded runtime behavior.
      return Reflect.apply(originalSplit, this, [separator, limit]) as string[];
    });

    try {
      expect(tokens("docs/intro.md")).toEqual(["docs/intro.md"]);
    } finally {
      split.mockRestore();
    }
  });

  it("skips malformed bare-path regex matches without a named path group", () => {
    const originalExec = RegExp.prototype.exec;
    let barePathCalls = 0;
    const exec = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, value: string) {
      if (this.source.includes("(?<path>") && value === "docs/intro.md") {
        barePathCalls += 1;
        if (barePathCalls === 1) {
          const match = ["docs/intro.md"];
          Object.defineProperties(match, {
            index: { value: 0 },
            input: { value },
          });

          // Type assertion: RegExpExecArray cannot express a missing `groups`
          // object, but the scanner has a defensive fallback for it.
          return match as unknown as RegExpExecArray;
        }
        return null;
      }
      return originalExec.call(this, value);
    });

    try {
      expect(tokens("docs/intro.md")).toEqual([]);
    } finally {
      exec.mockRestore();
    }
  });

  it("reports byte offsets that point to the raw token inside the input", () => {
    const text = "Hello docs/intro.md world";
    const matches = scanBareDocPathTokens(text);
    expect(matches).toHaveLength(1);
    const m = matches[0];
    if (!m) throw new Error("expected one match");
    expect(text.slice(m.start, m.end)).toBe("docs/intro.md");
  });
});

describe("stripDocPathLineSuffix", () => {
  it("returns the path unchanged when no line suffix is present", () => {
    expect(stripDocPathLineSuffix("docs/intro.md")).toBe("docs/intro.md");
  });

  it("drops :line and :line:col suffixes", () => {
    expect(stripDocPathLineSuffix("docs/intro.md:12")).toBe("docs/intro.md");
    expect(stripDocPathLineSuffix("docs/api.md:42:13")).toBe("docs/api.md");
  });

  it("returns the raw value when it is not a markdown path", () => {
    expect(stripDocPathLineSuffix("not-a-doc.txt:12")).toBe("not-a-doc.txt:12");
  });
});

describe("markdownCodeSpanRanges", () => {
  function covered(text: string): string[] {
    return markdownCodeSpanRanges(text).map((r) => text.slice(r.start, r.end));
  }

  it("returns no ranges when there is no code", () => {
    expect(markdownCodeSpanRanges("plain text\nno code here")).toEqual([]);
  });

  it("covers a simple backtick and tilde fence", () => {
    expect(covered("a\n```\ncode\n```\nb")).toEqual(["```\ncode\n```"]);
    expect(covered("~~~\ncode\n~~~")).toEqual(["~~~\ncode\n~~~"]);
  });

  it("closes a fence only on a same-char run at least as long as the opener", () => {
    // A 3-backtick line inside a 4-backtick block does NOT close it.
    const text = "````\n```\nstill code\n````\nafter";
    expect(covered(text)).toEqual(["````\n```\nstill code\n````"]);
  });

  it("extends an unclosed fence to end of input", () => {
    const text = "intro\n```\nnever closed";
    expect(markdownCodeSpanRanges(text)).toEqual([{ start: 6, end: text.length }]);
  });

  it("covers single- and multi-backtick inline spans (delimiter-aware)", () => {
    expect(covered("use `code` here")).toEqual(["`code`"]);
    // A double-backtick span may contain single backticks; closes on ``.
    expect(covered("a ``x `y` z`` b")).toEqual(["``x `y` z``"]);
  });

  it("closes an inline span only on an EXACT-length backtick run (not a longer one)", () => {
    // `` opener, a stray ``` run (not a close), then the real `` close.
    expect(covered("a ``x ``` y`` b")).toEqual(["``x ``` y``"]);
  });

  it("covers an inline code span that contains a line ending (multiline)", () => {
    const text = "before `line 1\nstill code` after";
    expect(covered(text)).toEqual(["`line 1\nstill code`"]);
  });

  it("does not treat inline backticks inside a fenced block as separate spans", () => {
    expect(covered("```\n`inside`\n```")).toEqual(["```\n`inside`\n```"]);
  });
});
