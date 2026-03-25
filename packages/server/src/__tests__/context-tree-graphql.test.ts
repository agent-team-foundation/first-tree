import { describe, expect, it } from "vitest";
import { parseNodeMetadata, parseRepo } from "../services/context-tree-graphql.js";

describe("parseRepo", () => {
  it("parses owner/repo format", () => {
    expect(parseRepo("baixiaohang/test-context-tree")).toEqual({
      owner: "baixiaohang",
      name: "test-context-tree",
    });
  });

  it("parses full GitHub URL", () => {
    expect(parseRepo("https://github.com/baixiaohang/test-context-tree")).toEqual({
      owner: "baixiaohang",
      name: "test-context-tree",
    });
  });

  it("parses GitHub URL with .git suffix", () => {
    expect(parseRepo("https://github.com/org/repo.git")).toEqual({
      owner: "org",
      name: "repo",
    });
  });

  it("parses GitHub URL with trailing slash", () => {
    expect(parseRepo("https://github.com/org/repo/")).toEqual({
      owner: "org",
      name: "repo",
    });
  });

  it("returns empty strings for invalid input", () => {
    const result = parseRepo("invalid");
    expect(result.owner).toBe("invalid");
    expect(result.name).toBe("");
  });
});

describe("parseNodeMetadata", () => {
  it("parses frontmatter with type and display_name", () => {
    const content = `---
type: personal_assistant
display_name: My Agent
---

# Some content`;

    const meta = parseNodeMetadata(content);
    expect(meta.type).toBe("personal_assistant");
    expect(meta.displayName).toBe("My Agent");
  });

  it("parses frontmatter with name fallback", () => {
    const content = `---
type: human
name: Bai
---`;

    const meta = parseNodeMetadata(content);
    expect(meta.type).toBe("human");
    expect(meta.displayName).toBe("Bai");
  });

  it("defaults to autonomous_agent when no frontmatter", () => {
    const content = "# Just a heading\nSome text.";
    const meta = parseNodeMetadata(content);
    expect(meta.type).toBe("autonomous_agent");
    expect(meta.displayName).toBeNull();
  });

  it("defaults type when not specified in frontmatter", () => {
    const content = `---
display_name: Test
---`;

    const meta = parseNodeMetadata(content);
    expect(meta.type).toBe("autonomous_agent");
    expect(meta.displayName).toBe("Test");
  });

  it("handles empty frontmatter", () => {
    const content = `---
---
Content here.`;

    const meta = parseNodeMetadata(content);
    expect(meta.type).toBe("autonomous_agent");
    expect(meta.displayName).toBeNull();
  });

  it("strips quotes from values", () => {
    const content = `---
type: "autonomous_agent"
display_name: 'My Agent'
---`;

    const meta = parseNodeMetadata(content);
    expect(meta.type).toBe("autonomous_agent");
    expect(meta.displayName).toBe("My Agent");
  });
});
