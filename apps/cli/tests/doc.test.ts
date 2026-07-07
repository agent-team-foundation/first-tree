import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerDocCommands } from "../src/commands/doc/index.js";
import { planMarkdownImport, slugFromFilename, titleFromMarkdown } from "../src/core/doc-review.js";

describe("slugFromFilename", () => {
  it("uses the basename without its extension", () => {
    expect(slugFromFilename("/tmp/designs/Chat Rename Plan.md")).toBe("chat-rename-plan");
    expect(slugFromFilename("proposal.md")).toBe("proposal");
    expect(slugFromFilename("doc-review.v2.md")).toBe("doc-review-v2");
  });

  it("collapses non-alphanumeric runs and trims edge dashes", () => {
    expect(slugFromFilename("__My  (Draft)__.md")).toBe("my-draft");
    expect(slugFromFilename("设计文档.md")).toBeNull();
    expect(slugFromFilename("---.md")).toBeNull();
  });
});

describe("titleFromMarkdown", () => {
  it("returns the first ATX heading at any level", () => {
    expect(titleFromMarkdown("# Top Title\n\nbody")).toBe("Top Title");
    expect(titleFromMarkdown("intro paragraph\n\n## Second-Level First\n# Later H1")).toBe("Second-Level First");
  });

  it("skips headings inside fenced code blocks", () => {
    const fenced = ["```bash", "# not a title, a shell comment", "```", "", "## Real Title"].join("\n");
    expect(titleFromMarkdown(fenced)).toBe("Real Title");
    const tildeFenced = ["~~~", "# still code", "~~~", "# After Fence"].join("\n");
    expect(titleFromMarkdown(tildeFenced)).toBe("After Fence");
    // An unclosed fence swallows the rest of the doc.
    expect(titleFromMarkdown("```\n# inside forever")).toBeNull();
  });

  it("trims trailing whitespace and returns null without a heading", () => {
    expect(titleFromMarkdown("### Padded Title   \n")).toBe("Padded Title");
    expect(titleFromMarkdown("no headings here\njust prose")).toBeNull();
    expect(titleFromMarkdown("")).toBeNull();
    // A fence-like or #-less line must not match.
    expect(titleFromMarkdown("#not-a-heading (no space)")).toBeNull();
  });
});

describe("planMarkdownImport", () => {
  it("plans unique-slug markdown files and skips the rest with reasons", () => {
    const plan = planMarkdownImport([
      "/p/NODE.md",
      "/p/README.md",
      "/p/design-doc.md",
      "/p/notes.txt",
      "/p/设计文档.md",
      "/p/design doc.md",
    ]);
    expect(plan.candidates).toEqual([{ path: "/p/design-doc.md", slug: "design-doc" }]);
    expect(plan.skipped.map((s) => s.path)).toEqual([
      "/p/NODE.md", // index file
      "/p/README.md", // index file
      "/p/notes.txt", // not markdown
      "/p/设计文档.md", // no derivable slug
      "/p/design doc.md", // slug collision with design-doc.md
    ]);
    expect(plan.skipped.find((s) => s.path === "/p/design doc.md")?.reason).toContain("already taken");
  });
});

describe("registerDocCommands", () => {
  it("wires the doc namespace with every subcommand", () => {
    const program = new Command();
    registerDocCommands(program);

    const doc = program.commands.find((c) => c.name() === "doc");
    expect(doc).toBeDefined();
    const names = (doc?.commands ?? []).map((c) => c.name()).sort();
    expect(names).toEqual([
      "comment",
      "comments",
      "export",
      "get",
      "import",
      "list",
      "publish",
      "reply",
      "resolve",
      "status",
    ]);
  });

  it("keeps subcommand descriptions non-empty (agents discover the surface via --help)", () => {
    const program = new Command();
    registerDocCommands(program);
    const doc = program.commands.find((c) => c.name() === "doc");
    for (const sub of doc?.commands ?? []) {
      expect(sub.description().length, `description of ${sub.name()}`).toBeGreaterThan(10);
    }
  });
});
