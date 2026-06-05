import { describe, expect, it } from "vitest";
import { isNavigableWebHref } from "../safe-href.js";

describe("isNavigableWebHref", () => {
  it("accepts absolute web URLs", () => {
    expect(isNavigableWebHref("https://cloud.first-tree.ai/docs")).toBe(true);
    expect(isNavigableWebHref("http://example.com")).toBe(true);
    expect(isNavigableWebHref("HTTPS://EXAMPLE.COM")).toBe(true);
  });

  it("accepts mailto / tel actions", () => {
    expect(isNavigableWebHref("mailto:hi@first-tree.ai")).toBe(true);
    expect(isNavigableWebHref("tel:+15551234567")).toBe(true);
  });

  it("accepts protocol-relative URLs and in-page fragments", () => {
    expect(isNavigableWebHref("//example.com/x")).toBe(true);
    expect(isNavigableWebHref("#section")).toBe(true);
    expect(isNavigableWebHref("  #section  ")).toBe(true);
  });

  it("rejects local filesystem paths (Issue 831)", () => {
    // The exact shape an agent emits while building a context tree.
    expect(isNavigableWebHref("/Users/gandy/.first-tree/data/workspaces/gandy-s-assistant/worktrees/build-tree")).toBe(
      false,
    );
    expect(isNavigableWebHref("/home/u/.first-tree/worktrees/x")).toBe(false);
    expect(isNavigableWebHref("~/.first-tree/worktrees/x")).toBe(false);
    expect(isNavigableWebHref("file:///Users/gandy/notes.md")).toBe(false);
  });

  it("rejects relative paths and non-web schemes", () => {
    expect(isNavigableWebHref("docs/foo.md")).toBe(false);
    expect(isNavigableWebHref("./a/b")).toBe(false);
    expect(isNavigableWebHref("../a/b")).toBe(false);
    expect(isNavigableWebHref("javascript:alert(1)")).toBe(false);
    expect(isNavigableWebHref("vscode://file/x")).toBe(false);
    expect(isNavigableWebHref("ftp://host/x")).toBe(false);
  });

  it("rejects empty / nullish hrefs", () => {
    expect(isNavigableWebHref("")).toBe(false);
    expect(isNavigableWebHref("   ")).toBe(false);
    expect(isNavigableWebHref(null)).toBe(false);
    expect(isNavigableWebHref(undefined)).toBe(false);
  });
});
