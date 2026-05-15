import { describe, expect, it } from "vitest";
import { isCanonicalDocLinkPath, normalizeDocLinkPath } from "../doc-path.js";

describe("normalizeDocLinkPath", () => {
  it("returns the canonical workspace-relative form", () => {
    expect(normalizeDocLinkPath("docs/design.md")).toBe("docs/design.md");
    expect(normalizeDocLinkPath("./docs/design.md")).toBe("docs/design.md");
    expect(normalizeDocLinkPath("/docs/design.md")).toBe("docs/design.md");
    expect(normalizeDocLinkPath("docs/api/../design.md")).toBe("docs/design.md");
  });

  it("rejects empty / whitespace / non-string input", () => {
    expect(normalizeDocLinkPath("")).toBeNull();
    expect(normalizeDocLinkPath("   ")).toBeNull();
    expect(normalizeDocLinkPath(undefined as unknown as string)).toBeNull();
  });

  it("rejects paths that escape above the workspace root", () => {
    expect(normalizeDocLinkPath("../secret.md")).toBeNull();
    expect(normalizeDocLinkPath("docs/../../secret.md")).toBeNull();
  });

  it("rejects any segment that starts with a dot (hidden / dotfile / .agent / .git)", () => {
    expect(normalizeDocLinkPath(".agent/secret.md")).toBeNull();
    expect(normalizeDocLinkPath("docs/.hidden.md")).toBeNull();
    expect(normalizeDocLinkPath(".git/HEAD.md")).toBeNull();
    expect(normalizeDocLinkPath("docs/.git/HEAD.md")).toBeNull();
  });

  it("rejects external-link forms so runtime never resolves them as workspace paths", () => {
    // Without this guard `normalizeDocLinkPath("https://x.com/a.md")` would
    // canonicalise to `https:/x.com/a.md` and the runtime would try to read
    // it on disk — proposal §非目标 explicitly forbids that.
    expect(normalizeDocLinkPath("https://example.com/readme.md")).toBeNull();
    expect(normalizeDocLinkPath("http://example.com/a.md")).toBeNull();
    expect(normalizeDocLinkPath("mailto:hello@example.com")).toBeNull();
    expect(normalizeDocLinkPath("ftp://host/a.md")).toBeNull();
    // Scheme-relative
    expect(normalizeDocLinkPath("//example.com/readme.md")).toBeNull();
    // Pure fragment
    expect(normalizeDocLinkPath("#heading")).toBeNull();
  });

  it("strips empty / `.` segments without rejecting", () => {
    expect(normalizeDocLinkPath("docs//design.md")).toBe("docs/design.md");
    expect(normalizeDocLinkPath("docs/./design.md")).toBe("docs/design.md");
  });

  it("rejects embedded query / fragment so the path layer never holds href artefacts", () => {
    expect(normalizeDocLinkPath("docs/a.md?x=1")).toBeNull();
    expect(normalizeDocLinkPath("docs/a.md#section")).toBeNull();
    expect(normalizeDocLinkPath("docs?/a.md")).toBeNull();
  });
});

describe("isCanonicalDocLinkPath", () => {
  it("returns true only for already-canonical paths", () => {
    expect(isCanonicalDocLinkPath("docs/design.md")).toBe(true);
    expect(isCanonicalDocLinkPath("a.md")).toBe(true);
  });

  it("returns false for anything that would change under normalisation", () => {
    expect(isCanonicalDocLinkPath("./docs/a.md")).toBe(false);
    expect(isCanonicalDocLinkPath("/docs/a.md")).toBe(false);
    expect(isCanonicalDocLinkPath("docs/../a.md")).toBe(false);
    expect(isCanonicalDocLinkPath("docs/")).toBe(false);
  });

  it("returns false for paths the normaliser rejects (external / hidden / escape)", () => {
    expect(isCanonicalDocLinkPath("https://x/a.md")).toBe(false);
    expect(isCanonicalDocLinkPath(".agent/x.md")).toBe(false);
    expect(isCanonicalDocLinkPath("../x.md")).toBe(false);
  });
});
