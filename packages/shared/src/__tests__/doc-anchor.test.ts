import { describe, expect, it } from "vitest";
import { buildDocAnchor, locateDocAnchor } from "../doc-anchor.js";

const SOURCE = [
  "# Design Doc",
  "",
  "We use soft delete because audit trails matter.",
  "",
  "The cache is per-tenant. The cache is per-tenant on purpose.",
  "",
  "```ts",
  "const cache = new Map();",
  "```",
].join("\n");

describe("buildDocAnchor", () => {
  it("anchors a unique selection with raw-source context", () => {
    const anchor = buildDocAnchor({ source: SOURCE, selectedText: "soft delete" });
    expect(anchor).not.toBeNull();
    expect(anchor?.exact).toBe("soft delete");
    expect(anchor?.prefix?.endsWith("We use ")).toBe(true);
    expect(anchor?.suffix?.startsWith(" because")).toBe(true);
  });

  it("survives whitespace differences between rendered selection and source", () => {
    // Rendered text collapses the newline between the two sentences to a space.
    const anchor = buildDocAnchor({
      source: "line one\nline two ends here",
      selectedText: "one line two",
    });
    expect(anchor?.exact).toBe("one\nline two");
  });

  it("disambiguates repeated text via rendered context", () => {
    const anchor = buildDocAnchor({
      source: SOURCE,
      selectedText: "The cache is per-tenant",
      renderedSuffix: " on purpose.",
    });
    expect(anchor).not.toBeNull();
    // The second occurrence is the one followed by "on purpose".
    expect(anchor?.suffix?.startsWith(" on purpose")).toBe(true);
  });

  it("returns null when the selection is absent from the source", () => {
    expect(buildDocAnchor({ source: SOURCE, selectedText: "not in the document" })).toBeNull();
    expect(buildDocAnchor({ source: SOURCE, selectedText: "   " })).toBeNull();
  });

  it("returns null when whitespace re-expansion pushes the raw exact past the schema cap", () => {
    // Normalized selection is well under the cap, but the source stores the
    // same words separated by huge whitespace runs — the raw slice would
    // exceed DOC_ANCHOR_EXACT_MAX and be rejected server-side.
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`);
    const source = `intro\n${words.join("\n".repeat(60))}\noutro`;
    const selected = words.join(" ");
    expect(selected.length).toBeLessThan(2_000);
    expect(buildDocAnchor({ source, selectedText: selected })).toBeNull();
  });
});

describe("locateDocAnchor", () => {
  it("round-trips an anchor built from a selection", () => {
    const anchor = buildDocAnchor({ source: SOURCE, selectedText: "audit trails matter" });
    expect(anchor).not.toBeNull();
    if (!anchor) return;
    const range = locateDocAnchor(SOURCE, anchor);
    expect(range).not.toBeNull();
    if (!range) return;
    expect(SOURCE.slice(range.start, range.end)).toBe("audit trails matter");
  });

  it("re-locates after unrelated edits (the re-anchor case)", () => {
    const anchor = buildDocAnchor({ source: SOURCE, selectedText: "soft delete" });
    if (!anchor) throw new Error("anchor expected");
    const v2 = `# Design Doc v2\n\nIntro paragraph.\n\n${SOURCE.slice(SOURCE.indexOf("We use"))}`;
    const range = locateDocAnchor(v2, anchor);
    expect(range).not.toBeNull();
    if (!range) return;
    expect(v2.slice(range.start, range.end)).toBe("soft delete");
  });

  it("uses prefix/suffix to pick among repeated occurrences", () => {
    const source = "alpha beta gamma. alpha beta delta.";
    const range = locateDocAnchor(source, { exact: "alpha beta", suffix: " delta" });
    expect(range).not.toBeNull();
    if (!range) return;
    expect(range.start).toBe(source.indexOf("alpha beta delta"));
  });

  it("returns null when the quoted text was deleted", () => {
    const anchor = buildDocAnchor({ source: SOURCE, selectedText: "soft delete" });
    if (!anchor) throw new Error("anchor expected");
    const v2 = SOURCE.replace("soft delete", "hard delete");
    expect(locateDocAnchor(v2, anchor)).toBeNull();
  });

  it("tolerates whitespace-only reflows of the quote", () => {
    const anchor = { exact: "audit trails matter" };
    const reflowed = SOURCE.replace("audit trails matter", "audit\n  trails   matter");
    const range = locateDocAnchor(reflowed, anchor);
    expect(range).not.toBeNull();
    if (!range) return;
    expect(reflowed.slice(range.start, range.end)).toBe("audit\n  trails   matter");
  });
});
