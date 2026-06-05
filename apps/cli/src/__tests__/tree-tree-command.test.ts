import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function writeNode(path: string, title: string, description?: string): void {
  const descriptionLine = description === undefined ? "" : `description: ${description}\n`;
  writeFileSync(join(path, "NODE.md"), `---\ntitle: ${title}\n${descriptionLine}---\n# ${title}\n`);
}

function writeLeaf(path: string, title: string, description?: string): void {
  const descriptionLine = description === undefined ? "" : `description: ${description}\n`;
  writeFileSync(path, `---\ntitle: ${title}\n${descriptionLine}---\n# ${title}\n`);
}

function makeTreeFixture(): string {
  const base = makeTempDir("ft-tree-tree-");
  const root = join(base, "knowledge");
  const domains = join(root, "domains");
  const api = join(domains, "api");
  const scratch = join(root, "scratch");

  mkdirSync(api, { recursive: true });
  mkdirSync(scratch, { recursive: true });

  writeNode(root, "Root Node", "Root description");
  writeNode(domains, "Domains", "Product domains");
  writeNode(api, "API");
  writeLeaf(join(api, "auth.md"), "Auth Leaf", "Login flows");
  writeLeaf(join(api, "payments.md"), "Payments Leaf", "Billing flows");
  writeLeaf(join(domains, "ops.md"), "Operations Leaf", "Runbooks");
  writeLeaf(join(root, "guide.md"), "Guide Leaf", "How to navigate");
  writeLeaf(join(scratch, "note.md"), "Scratch Note", "Temporary details");

  writeFileSync(join(root, "AGENTS.md"), "---\ntitle: Should Skip Agents\n---\n");
  writeFileSync(join(root, "CLAUDE.md"), "---\ntitle: Should Skip Claude\n---\n");
  writeLeaf(join(root, ".secret.md"), "Should Skip Hidden File", "Hidden");

  for (const generatedDir of [".hidden", "node_modules", "__pycache__", "dist", "build", ".next", ".turbo"]) {
    const ignored = join(root, generatedDir);
    mkdirSync(ignored, { recursive: true });
    writeNode(ignored, "Should Skip Generated", "Generated");
    writeLeaf(join(ignored, "ignored.md"), "Should Skip Leaf", "Generated");
  }

  return root;
}

function commandWithOptions(options: Record<string, unknown>): Command {
  const command = new Command("test");
  for (const [key, value] of Object.entries(options)) {
    command.setOptionValue(key, value);
  }
  return command;
}

function context(command: Command, options: Partial<CommandContext["options"]> = {}): CommandContext {
  return { command, options: { debug: false, json: false, quiet: false, ...options } };
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
  it("renders the current node, child directory nodes, and leaf markdown nodes", () => {
    const root = makeTreeFixture();

    expect(renderContextTree(root)).toBe(
      [
        'knowledge/ [NODE.md] title="Root Node" description="Root description"',
        '├── domains/ [NODE.md] title="Domains" description="Product domains"',
        '│   ├── api/ [NODE.md] title="API" description="-"',
        '│   │   ├── auth.md title="Auth Leaf" description="Login flows"',
        '│   │   └── payments.md title="Payments Leaf" description="Billing flows"',
        '│   └── ops.md title="Operations Leaf" description="Runbooks"',
        '├── guide.md title="Guide Leaf" description="How to navigate"',
        '└── scratch/ title="-" description="-"',
        '    └── note.md title="Scratch Note" description="Temporary details"',
      ].join("\n"),
    );
  });

  it("applies deterministic depth limits", () => {
    const root = makeTreeFixture();

    expect(renderContextTree(root, { maxDepth: 0 })).toBe(
      'knowledge/ [NODE.md] title="Root Node" description="Root description"',
    );
    expect(renderContextTree(root, { maxDepth: 1 })).toBe(
      [
        'knowledge/ [NODE.md] title="Root Node" description="Root description"',
        '├── domains/ [NODE.md] title="Domains" description="Product domains"',
        '└── guide.md title="Guide Leaf" description="How to navigate"',
      ].join("\n"),
    );
    expect(renderContextTree(root, { maxDepth: 2 })).toBe(
      [
        'knowledge/ [NODE.md] title="Root Node" description="Root description"',
        '├── domains/ [NODE.md] title="Domains" description="Product domains"',
        '│   ├── api/ [NODE.md] title="API" description="-"',
        '│   └── ops.md title="Operations Leaf" description="Runbooks"',
        '├── guide.md title="Guide Leaf" description="How to navigate"',
        '└── scratch/ title="-" description="-"',
        '    └── note.md title="Scratch Note" description="Temporary details"',
      ].join("\n"),
    );
  });

  it("matches patterns against relative path, basename, title, and description", () => {
    const root = makeTreeFixture();

    expect(renderContextTree(root, { pattern: "domains/api/auth.md" })).toContain(
      'auth.md title="Auth Leaf" description="Login flows"',
    );
    expect(renderContextTree(root, { pattern: "guide.md" })).toContain(
      'guide.md title="Guide Leaf" description="How to navigate"',
    );
    expect(renderContextTree(root, { pattern: "Auth*" })).toContain(
      'auth.md title="Auth Leaf" description="Login flows"',
    );
    expect(renderContextTree(root, { pattern: "Billing*" })).toContain(
      'payments.md title="Payments Leaf" description="Billing flows"',
    );
  });

  it("preserves ancestors for matched descendants after applying depth limits", () => {
    const root = makeTreeFixture();

    expect(renderContextTree(root, { pattern: "Payments*" })).toBe(
      [
        'knowledge/ [NODE.md] title="Root Node" description="Root description"',
        '└── domains/ [NODE.md] title="Domains" description="Product domains"',
        '    └── api/ [NODE.md] title="API" description="-"',
        '        └── payments.md title="Payments Leaf" description="Billing flows"',
      ].join("\n"),
    );
    expect(renderContextTree(root, { maxDepth: 2, pattern: "Payments*" })).toBe(
      'knowledge/ [NODE.md] title="Root Node" description="Root description"',
    );
  });

  it("skips hidden and generated paths plus non-node framework markdown files", () => {
    const root = makeTreeFixture();
    const output = renderContextTree(root);

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
  it("prints the rendered tree from the current directory to stderr in human mode", () => {
    const root = makeTreeFixture();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.chdir(root);

    runTreeTreeCommand(context(commandWithOptions({ level: "1" })));

    expect(stdout.mock.calls.map((call) => String(call[0])).join("")).toBe("");
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toBe(
      `${[
        'knowledge/ [NODE.md] title="Root Node" description="Root description"',
        '├── domains/ [NODE.md] title="Domains" description="Product domains"',
        '└── guide.md title="Guide Leaf" description="How to navigate"',
      ].join("\n")}\n`,
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("prints a JSON envelope to stdout in explicit JSON mode", () => {
    const root = makeTreeFixture();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.chdir(root);
    const expectedRoot = process.cwd();

    runTreeTreeCommand(context(commandWithOptions({ level: "3", pattern: "Auth*" }), { json: true }));

    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toBe("");
    const envelope = JSON.parse(stdout.mock.calls.map((call) => String(call[0])).join(""));

    expect(envelope).toMatchObject({
      ok: true,
      data: {
        root: expectedRoot,
        options: {
          level: 3,
          pattern: "Auth*",
        },
        tree: {
          kind: "directory",
          name: "knowledge",
          relativePath: "",
          depth: 0,
          metadata: {
            title: "Root Node",
            description: "Root description",
          },
          hasNode: true,
        },
      },
    });
    expect(envelope.data.tree.children).toEqual([
      {
        kind: "directory",
        name: "domains",
        relativePath: "domains",
        depth: 1,
        metadata: {
          title: "Domains",
          description: "Product domains",
        },
        hasNode: true,
        children: [
          {
            kind: "directory",
            name: "api",
            relativePath: "domains/api",
            depth: 2,
            metadata: {
              title: "API",
              description: "-",
            },
            hasNode: true,
            children: [
              {
                kind: "file",
                name: "auth.md",
                relativePath: "domains/api/auth.md",
                depth: 3,
                metadata: {
                  title: "Auth Leaf",
                  description: "Login flows",
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

    runTreeTreeCommand(context(commandWithOptions({ level: "0" }), { json: false }));

    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toBe("");
    expect(JSON.parse(stdout.mock.calls.map((call) => String(call[0])).join(""))).toMatchObject({
      ok: true,
      data: {
        root: expectedRoot,
        options: {
          level: 0,
        },
        tree: {
          name: "knowledge",
          children: [],
        },
      },
    });
  });

  it("rejects negative and non-integer levels with a stable error envelope", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
      throw new ProcessExit(typeof code === "number" ? code : 0);
    });

    expect(() => parseTreeLevel("-1")).toThrow("Invalid --level");
    expect(() => parseTreeLevel("1.5")).toThrow("Invalid --level");

    expect(() => runTreeTreeCommand(context(commandWithOptions({ level: "-1" })))).toThrow(ProcessExit);

    expect(exit).toHaveBeenCalledWith(1);
    expect(stdout.mock.calls.map((call) => String(call[0])).join("")).toBe("");
    expect(JSON.parse(stderr.mock.calls.map((call) => String(call[0])).join(""))).toEqual({
      ok: false,
      error: {
        code: "TREE_TREE_INVALID_LEVEL",
        message: "Invalid --level: expected a non-negative integer.",
      },
    });
  });
});
