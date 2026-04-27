import { describe, expect, it } from "vitest";
import { slugifyWorkspace } from "../workspace-slug.js";

describe("slugifyWorkspace", () => {
  it("lowercases and hyphenates the canonical case", () => {
    expect(slugifyWorkspace("Acme Engineering")).toBe("acme-engineering");
    expect(slugifyWorkspace("First Tree Hub")).toBe("first-tree-hub");
  });

  it("collapses runs of non-alphanumerics into a single hyphen", () => {
    expect(slugifyWorkspace("a   b---c__d")).toBe("a-b-c-d");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugifyWorkspace("  Hello!  ")).toBe("hello");
    expect(slugifyWorkspace("---startup---")).toBe("startup");
  });

  it("caps the slug at 50 characters to match the server constraint", () => {
    const long = "a".repeat(80);
    expect(slugifyWorkspace(long).length).toBe(50);
  });

  it("returns an empty string for inputs with no alphanumerics — UI handles that explicitly", () => {
    expect(slugifyWorkspace("")).toBe("");
    expect(slugifyWorkspace("!@#$%")).toBe("");
    expect(slugifyWorkspace("李小明")).toBe("");
  });

  it("preserves digits and is idempotent on already-slugged input", () => {
    expect(slugifyWorkspace("acme-7")).toBe("acme-7");
    const slug = slugifyWorkspace("Hello World 2");
    expect(slugifyWorkspace(slug)).toBe(slug);
  });
});
