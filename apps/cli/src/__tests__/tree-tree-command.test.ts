import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTreeLevel, renderContextTree, runTreeTreeCommand } from "../commands/tree/tree.js";
import type { CommandContext } from "../commands/types.js";
import { setJsonMode } from "../core/output.js";

const originalCwd = process.cwd();
const originalFirstTreeJson = process.env.FIRST_TREE_JSON;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function frontmatter(fields: string): string {
  return `---\n${fields}---\n`;
}

function writeNode(path: string, title: string, description?: string): void {
  const descriptionLine = description === undefined ? "" : `description: ${description}\n`;
  writeFileSync(
    join(path, "NODE.md"),
    `${frontmatter(`title: ${title}\nowners: [alice]\n${descriptionLine}`)}# ${title}\n`,
  );
}

function writeLeaf(path: string, title: string, description?: string): void {
  const descriptionLine = description === undefined ? "" : `description: ${description}\n`;
  writeFileSync(path, `${frontmatter(`title: ${title}\nowners: [alice]\n${descriptionLine}`)}# ${title}\n`);
}

function writeMarkdown(path: string, fields: string): void {
  writeFileSync(path, `${frontmatter(fields)}# Invalid\n`);
}

function makeTreeFixture(): string {
  const base = makeTempDir("ft-tree-tree-");
  const root = join(base, "knowledge");
  const docs = join(root, "docs");
  const development = join(docs, "development");
  const deep = join(development, "deep");
  const missingTitle = join(root, "missing-title");
  const missingOwners = join(root, "missing-owners");
  const emptyOwners = join(root, "empty-owners");
  const scratch = join(root, "scratch");

  mkdirSync(deep, { recursive: true });
  mkdirSync(missingTitle, { recursive: true });
  mkdirSync(missingOwners, { recursive: true });
  mkdirSync(emptyOwners, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });

  writeNode(root, "Root Node", "Root description");
  writeNode(docs, "Docs", "Documentation");
  writeNode(development, "Development");
  writeNode(deep, "Deep Area", "Deep context");
  writeLeaf(join(deep, "leaf.md"), "Deep Leaf", "Deep leaf detail");
  writeLeaf(join(development, "http.md"), "HTTP Leaf", "HTTP routes");
  writeLeaf(join(docs, "ops.md"), "Operations Leaf", "Runbooks");
  writeLeaf(join(root, "guide.md"), "Guide Leaf", "How to navigate");

  writeMarkdown(join(missingTitle, "NODE.md"), "owners: [alice]\n");
  writeMarkdown(join(missingOwners, "NODE.md"), "title: Missing Owners\n");
  writeMarkdown(join(emptyOwners, "NODE.md"), "title: Empty Owners\nowners: []\n");
  writeMarkdown(join(development, "missing-title.md"), "owners: [alice]\n");
  writeMarkdown(join(development, "missing-owners.md"), "title: Missing Owners Leaf\n");
  writeMarkdown(join(development, "empty-owners.md"), "title: Empty Owners Leaf\nowners: []\n");
  writeLeaf(join(scratch, "note.md"), "Scratch Note", "Temporary details");
  writeFileSync(join(development, "notes.txt"), "not markdown\n");
  writeFileSync(join(root, "AGENTS.md"), frontmatter("title: Should Skip Agents\nowners: [alice]\n"));
  writeFileSync(join(root, "CLAUDE.md"), frontmatter("title: Should Skip Claude\nowners: [alice]\n"));
  writeLeaf(join(root, ".secret.md"), "Should Skip Hidden File", "Hidden");

  for (const generatedDir of [".hidden", "node_modules", "__pycache__", "dist", "build", ".next", ".turbo"]) {
    const ignored = join(root, generatedDir);
    mkdirSync(ignored, { recursive: true });
    writeNode(ignored, "Should Skip Generated", "Generated");
    writeLeaf(join(ignored, "ignored.md"), "Should Skip Leaf", "Generated");
  }

  return root;
}

function commandWithOptions(options: Record<string, unknown>, args: string[] = []): Command {
  const command = new Command("test");
  command.args = args;

  for (const [key, value] of Object.entries(options)) {
    command.setOptionValue(key, value);
  }

  return command;
}

function context(command: Command, options: Partial<CommandContext["options"]> = {}): CommandContext {
  return { command, options: { debug: false, json: false, quiet: false, ...options } };
}

function readMockOutput(spy: { mock: { calls: readonly (readonly unknown[])[] } }): string {
  return spy.mock.calls.map((call) => String(call[0])).join("");
}

class ProcessExit extends Error {
  constructor(public exitCode: number) {
    super(`process.exit:${exitCode}`);
    this.name = "ProcessExit";
  }
}

beforeEach(() => {
  setJsonMode(false);
  process.exitCode = undefined;
});

afterEach(() => {
  if (originalFirstTreeJson === undefined) {
    delete process.env.FIRST_TREE_JSON;
  } else {
    process.env.FIRST_TREE_JSON = originalFirstTreeJson;
  }

  setJsonMode(false);
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  process.exitCode = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("tree tree renderer", () => {
  it("renders only valid Context Tree nodes with concise metadata labels", () => {
    const root = makeTreeFixture();

    expect(renderContextTree(root)).toBe(
      [
        "knowledge/ [Root Node] -> Root description",
        "├── docs/ [Docs] -> Documentation",
        "│   ├── docs/development/ [Development]",
        "│   │   ├── docs/development/deep/ [Deep Area] -> Deep context",
        "│   │   │   └── docs/development/deep/leaf.md [Deep Leaf] -> Deep leaf detail",
        "│   │   └── docs/development/http.md [HTTP Leaf] -> HTTP routes",
        "│   └── docs/ops.md [Operations Leaf] -> Runbooks",
        "└── guide.md [Guide Leaf] -> How to navigate",
      ].join("\n"),
    );
  });

  it("applies depth limits only below the selected target path", () => {
    const root = makeTreeFixture();

    expect(renderContextTree(root, { maxDepth: 0, path: "docs/development" })).toBe(
      [
        "knowledge/ [Root Node] -> Root description",
        "└── docs/ [Docs] -> Documentation",
        "    └── docs/development/ [Development]",
      ].join("\n"),
    );
    expect(renderContextTree(root, { maxDepth: 1, path: "docs/development" })).toBe(
      [
        "knowledge/ [Root Node] -> Root description",
        "└── docs/ [Docs] -> Documentation",
        "    └── docs/development/ [Development]",
        "        ├── docs/development/deep/ [Deep Area] -> Deep context",
        "        └── docs/development/http.md [HTTP Leaf] -> HTTP routes",
      ].join("\n"),
    );
  });

  it("matches patterns against relative path, filename, title, and description while preserving ancestors", () => {
    const root = makeTreeFixture();

    expect(renderContextTree(root, { pattern: "docs/development/http.md" })).toContain(
      "docs/development/http.md [HTTP Leaf] -> HTTP routes",
    );
    expect(renderContextTree(root, { pattern: "http.md" })).toContain(
      "docs/development/http.md [HTTP Leaf] -> HTTP routes",
    );
    expect(renderContextTree(root, { pattern: "HTTP*" })).toContain(
      "docs/development/http.md [HTTP Leaf] -> HTTP routes",
    );
    expect(renderContextTree(root, { pattern: "Deep leaf*" })).toBe(
      [
        "knowledge/ [Root Node] -> Root description",
        "└── docs/ [Docs] -> Documentation",
        "    └── docs/development/ [Development]",
        "        └── docs/development/deep/ [Deep Area] -> Deep context",
        "            └── docs/development/deep/leaf.md [Deep Leaf] -> Deep leaf detail",
      ].join("\n"),
    );
    expect(renderContextTree(root, { maxDepth: 0, path: "docs/development", pattern: "Deep*" })).toBe(
      [
        "knowledge/ [Root Node] -> Root description",
        "└── docs/ [Docs] -> Documentation",
        "    └── docs/development/ [Development]",
      ].join("\n"),
    );
  });

  it("filters invalid markdown nodes, hidden paths, generated directories, and non-markdown files", () => {
    const root = makeTreeFixture();
    const output = renderContextTree(root);

    expect(output).not.toContain("Missing");
    expect(output).not.toContain("Empty Owners");
    expect(output).not.toContain("Scratch Note");
    expect(output).not.toContain("notes.txt");
    expect(output).not.toContain("Should Skip");
    expect(output).not.toContain("AGENTS.md");
    expect(output).not.toContain("CLAUDE.md");
    expect(output).not.toContain(".secret.md");
    expect(output).not.toContain("node_modules");
    expect(output).not.toContain("__pycache__");
    expect(output).not.toContain("dist/");
    expect(output).not.toContain("build/");
    expect(output).not.toContain(".next");
    expect(output).not.toContain(".turbo");
  });
});

describe("tree tree command action", () => {
  it("prints the selected subtree with repo-root ancestor context in human mode", () => {
    const root = makeTreeFixture();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.chdir(root);

    runTreeTreeCommand(context(commandWithOptions({}, ["docs/development"])));

    expect(readMockOutput(stdout)).toBe("");
    expect(readMockOutput(stderr)).toBe(
      `${[
        "knowledge/ [Root Node] -> Root description",
        "└── docs/ [Docs] -> Documentation",
        "    └── docs/development/ [Development]",
        "        ├── docs/development/deep/ [Deep Area] -> Deep context",
        "        │   └── docs/development/deep/leaf.md [Deep Leaf] -> Deep leaf detail",
        "        └── docs/development/http.md [HTTP Leaf] -> HTTP routes",
      ].join("\n")}\n`,
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("treats a non-numeric -L value as a path only when no positional path is present", () => {
    const root = makeTreeFixture();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.chdir(root);

    runTreeTreeCommand(context(commandWithOptions({ level: "docs/development" })));

    expect(readMockOutput(stdout)).toBe("");
    expect(readMockOutput(stderr)).toContain("docs/development/http.md [HTTP Leaf] -> HTTP routes");
    expect(readMockOutput(stderr)).not.toContain("guide.md [Guide Leaf]");
  });

  it("combines numeric -L depth with a positional path", () => {
    const root = makeTreeFixture();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.chdir(root);

    runTreeTreeCommand(context(commandWithOptions({ level: "1" }, ["docs/development"])));

    expect(readMockOutput(stdout)).toBe("");
    expect(readMockOutput(stderr)).toBe(
      `${[
        "knowledge/ [Root Node] -> Root description",
        "└── docs/ [Docs] -> Documentation",
        "    └── docs/development/ [Development]",
        "        ├── docs/development/deep/ [Deep Area] -> Deep context",
        "        └── docs/development/http.md [HTTP Leaf] -> HTTP routes",
      ].join("\n")}\n`,
    );
  });

  it("prints a JSON envelope to stdout in explicit JSON mode", () => {
    const root = makeTreeFixture();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.chdir(root);
    const expectedRoot = process.cwd();

    runTreeTreeCommand(
      context(commandWithOptions({ level: "1", pattern: "HTTP*" }, ["docs/development"]), { json: true }),
    );

    expect(readMockOutput(stderr)).toBe("");
    const envelope = JSON.parse(readMockOutput(stdout));

    expect(envelope).toMatchObject({
      ok: true,
      data: {
        root: expectedRoot,
        target: "docs/development",
        options: {
          level: 1,
          pattern: "HTTP*",
          path: "docs/development",
        },
        tree: {
          kind: "directory",
          name: "knowledge",
          relativePath: "",
          depth: 0,
          metadata: {
            title: "Root Node",
            description: "Root description",
            owners: ["alice"],
          },
          hasNode: true,
        },
      },
    });
    expect(envelope.data.tree.children).toEqual([
      {
        kind: "directory",
        name: "docs",
        relativePath: "docs",
        depth: 1,
        metadata: {
          title: "Docs",
          description: "Documentation",
          owners: ["alice"],
        },
        hasNode: true,
        children: [
          {
            kind: "directory",
            name: "development",
            relativePath: "docs/development",
            depth: 2,
            metadata: {
              title: "Development",
              owners: ["alice"],
            },
            hasNode: true,
            children: [
              {
                kind: "file",
                name: "http.md",
                relativePath: "docs/development/http.md",
                depth: 3,
                metadata: {
                  title: "HTTP Leaf",
                  description: "HTTP routes",
                  owners: ["alice"],
                },
                hasNode: false,
                children: [],
              },
            ],
          },
        ],
      },
    ]);
  });

  it("prints JSON when the global Print layer is already in JSON mode", () => {
    const root = makeTreeFixture();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.chdir(root);
    const expectedRoot = process.cwd();
    process.env.FIRST_TREE_JSON = "1";
    setJsonMode(process.env.FIRST_TREE_JSON === "1");

    runTreeTreeCommand(context(commandWithOptions({ level: "0" }, ["docs/development"]), { json: false }));

    expect(readMockOutput(stderr)).toBe("");
    expect(JSON.parse(readMockOutput(stdout))).toMatchObject({
      ok: true,
      data: {
        root: expectedRoot,
        target: "docs/development",
        options: {
          level: 0,
          path: "docs/development",
        },
        tree: {
          name: "knowledge",
          children: [
            {
              name: "docs",
              children: [
                {
                  name: "development",
                  children: [],
                },
              ],
            },
          ],
        },
      },
    });
  });

  it("rejects invalid paths with a stable error envelope", () => {
    const root = makeTreeFixture();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
      throw new ProcessExit(typeof code === "number" ? code : 0);
    });
    process.chdir(root);

    expect(() => runTreeTreeCommand(context(commandWithOptions({}, ["missing"])))).toThrow(ProcessExit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(readMockOutput(stdout)).toBe("");
    expect(JSON.parse(readMockOutput(stderr))).toEqual({
      ok: false,
      error: {
        code: "TREE_TREE_INVALID_PATH",
        message: 'Path "missing" is not an existing directory.',
      },
    });
  });

  it("rejects repo-outside paths with a stable error envelope", () => {
    const root = makeTreeFixture();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
      throw new ProcessExit(typeof code === "number" ? code : 0);
    });
    process.chdir(root);

    expect(() => runTreeTreeCommand(context(commandWithOptions({}, [".."])))).toThrow(ProcessExit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(readMockOutput(stdout)).toBe("");
    expect(JSON.parse(readMockOutput(stderr))).toEqual({
      ok: false,
      error: {
        code: "TREE_TREE_INVALID_PATH",
        message: 'Path ".." is outside the git repository.',
      },
    });
  });

  it("rejects symlink targets that escape the repo with a stable error envelope", (ctx) => {
    const root = makeTreeFixture();
    const outsideRoot = makeTempDir("ft-tree-tree-outside-");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
      throw new ProcessExit(typeof code === "number" ? code : 0);
    });
    writeNode(outsideRoot, "Outside Node", "Escaped context");

    try {
      symlinkSync(outsideRoot, join(root, "outside"), "dir");
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }

    process.chdir(root);

    expect(() => runTreeTreeCommand(context(commandWithOptions({}, ["outside"])))).toThrow(ProcessExit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(readMockOutput(stdout)).toBe("");
    expect(JSON.parse(readMockOutput(stderr))).toEqual({
      ok: false,
      error: {
        code: "TREE_TREE_INVALID_PATH",
        message: 'Path "outside" is outside the git repository.',
      },
    });
  });

  it("rejects negative and non-integer levels with a stable error envelope", () => {
    const root = makeTreeFixture();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
      throw new ProcessExit(typeof code === "number" ? code : 0);
    });
    process.chdir(root);

    expect(() => parseTreeLevel("-1")).toThrow("Invalid --level");
    expect(() => parseTreeLevel("1.5")).toThrow("Invalid --level");

    expect(() => runTreeTreeCommand(context(commandWithOptions({ level: "-1" })))).toThrow(ProcessExit);

    expect(exit).toHaveBeenCalledWith(1);
    expect(readMockOutput(stdout)).toBe("");
    expect(JSON.parse(readMockOutput(stderr))).toEqual({
      ok: false,
      error: {
        code: "TREE_TREE_INVALID_LEVEL",
        message: "Invalid --level: expected a non-negative integer.",
      },
    });
  });
});
