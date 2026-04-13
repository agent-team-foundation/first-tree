import { describe, expect, it } from "vitest";
import { parseJoinArgs } from "#engine/join.js";

// --- parseJoinArgs ---

describe("parseJoinArgs", () => {
  it("parses all required flags", () => {
    const result = parseJoinArgs([
      "--tree-url",
      "https://github.com/org/tree.git",
      "--invite",
      "alice",
    ]);
    expect(result).toEqual({
      skipInstall: false,
      treeUrl: "https://github.com/org/tree.git",
      invite: "alice",
    });
  });

  it("parses optional --tree-path", () => {
    const result = parseJoinArgs([
      "--tree-url",
      "https://github.com/org/tree.git",
      "--invite",
      "alice",
      "--tree-path",
      "/tmp/my-tree",
    ]);
    expect(result).toEqual({
      skipInstall: false,
      treeUrl: "https://github.com/org/tree.git",
      invite: "alice",
      treePath: "/tmp/my-tree",
    });
  });

  it("parses optional --branch", () => {
    const result = parseJoinArgs([
      "--tree-url",
      "https://github.com/org/tree.git",
      "--invite",
      "alice",
      "--branch",
      "invite/alice",
    ]);
    expect(result).toEqual({
      skipInstall: false,
      treeUrl: "https://github.com/org/tree.git",
      invite: "alice",
      branch: "invite/alice",
    });
  });

  it("parses --skip-install flag", () => {
    const result = parseJoinArgs([
      "--tree-url",
      "https://github.com/org/tree.git",
      "--invite",
      "alice",
      "--skip-install",
    ]);
    expect(result).toEqual({
      skipInstall: true,
      treeUrl: "https://github.com/org/tree.git",
      invite: "alice",
    });
  });

  it("returns error for missing --tree-url", () => {
    const result = parseJoinArgs(["--invite", "alice"]);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/--tree-url/);
  });

  it("returns error for missing --invite", () => {
    const result = parseJoinArgs([
      "--tree-url",
      "https://github.com/org/tree.git",
    ]);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/--invite/);
  });

  it("returns error for unknown flag", () => {
    const result = parseJoinArgs([
      "--tree-url",
      "https://github.com/org/tree.git",
      "--invite",
      "alice",
      "--verbose",
    ]);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(/Unknown option/);
  });
});
