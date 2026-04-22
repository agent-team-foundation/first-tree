import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGardener } from "#products/gardener/cli.js";
import {
  buildWorkflowYaml,
  INSTALL_WORKFLOW_USAGE,
  isValidRepoSlug,
  parseInstallWorkflowFlags,
  runInstallWorkflow,
} from "#products/gardener/engine/install-workflow.js";
import { useTmpDir } from "../helpers.js";

function captureWrite(): { write: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return {
    write: (line: string): void => {
      for (const split of line.split("\n")) lines.push(split);
    },
    lines,
  };
}

describe("gardener install-workflow — flag parsing", () => {
  it("accepts --tree-repo and defaults the rest", () => {
    const flags = parseInstallWorkflowFlags([
      "--tree-repo",
      "acme/tree",
    ]);
    expect(flags.treeRepo).toBe("acme/tree");
    expect(flags.treePath).toBe(".first-tree-cache/tree");
    expect(flags.output).toBe(".github/workflows/first-tree-sync.yml");
    expect(flags.nodeVersion).toBe("22");
    expect(flags.dryRun).toBe(false);
    expect(flags.force).toBe(false);
    expect(flags.help).toBe(false);
  });

  it("parses overrides and toggles", () => {
    const flags = parseInstallWorkflowFlags([
      "--tree-repo",
      "acme/tree",
      "--tree-path",
      "vendor/tree",
      "--output",
      ".github/workflows/custom.yml",
      "--node-version",
      "20",
      "--force",
      "--dry-run",
    ]);
    expect(flags.treePath).toBe("vendor/tree");
    expect(flags.output).toBe(".github/workflows/custom.yml");
    expect(flags.nodeVersion).toBe("20");
    expect(flags.force).toBe(true);
    expect(flags.dryRun).toBe(true);
  });

  it("records unknown flags", () => {
    const flags = parseInstallWorkflowFlags(["--what", "x"]);
    expect(flags.unknown).toBe("--what");
  });
});

describe("gardener install-workflow — slug validation", () => {
  it.each([
    ["acme/tree", true],
    ["agent-team-foundation/first-tree-context", true],
    ["a.b/c_d", true],
    ["https://github.com/acme/tree", false],
    ["acme", false],
    ["/tree", false],
    ["acme/tree/extra", false],
    ["", false],
  ])("isValidRepoSlug(%s) === %s", (slug, ok) => {
    expect(isValidRepoSlug(slug)).toBe(ok);
  });
});

describe("gardener install-workflow — yaml builder", () => {
  it("embeds tree-repo, tree-path, node-version into the template", () => {
    const yaml = buildWorkflowYaml({
      treeRepo: "acme/tree",
      treePath: ".first-tree-cache/tree",
      nodeVersion: "22",
    });
    expect(yaml).toContain("name: First-Tree Sync");
    expect(yaml).toContain("persist-credentials: false");
    expect(yaml).toContain('tree_repo_url="https://github.com/acme/tree.git"');
    expect(yaml).toContain('tree_repo_dir=".first-tree-cache/tree"');
    expect(yaml).toContain("clone --depth 1");
    expect(yaml).toContain('if GIT_TERMINAL_PROMPT=0 GIT_ASKPASS= SSH_ASKPASS= git');
    expect(yaml).toContain('-c http.https://github.com/.extraheader=');
    expect(yaml).toContain('if [ -z "${TREE_REPO_TOKEN:-}" ]; then');
    expect(yaml).toContain('askpass_script="$RUNNER_TEMP/first-tree-git-askpass.sh"');
    expect(yaml).toContain("GIT_ASKPASS=\"$askpass_script\" git -c credential.helper= clone --depth 1");
    expect(yaml).toContain('node-version: "22"');
    expect(yaml).toContain("--assign-owners");
    expect(yaml).toContain(
      "first-tree gardener install-workflow",
    );
    expect(yaml).toContain("first-tree:sync");
    expect(yaml).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(yaml).toContain("TREE_REPO_TOKEN: ${{ secrets.TREE_REPO_TOKEN }}");
    expect(yaml).toContain(
      "ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}",
    );
    expect(yaml).toContain(
      "GARDENER_CLASSIFIER_MODEL: ${{ secrets.GARDENER_CLASSIFIER_MODEL }}",
    );
  });

  it("honors a custom tree-path override", () => {
    const yaml = buildWorkflowYaml({
      treeRepo: "acme/tree",
      treePath: "tree-checkout",
      nodeVersion: "20",
    });
    expect(yaml).toContain('tree_repo_dir="tree-checkout"');
    expect(yaml).toContain("--tree-path tree-checkout");
    expect(yaml).toContain('node-version: "20"');
  });
});

describe("gardener install-workflow — runInstallWorkflow", () => {
  it("writes the workflow file at the default path", async () => {
    const tmp = useTmpDir();
    const { write, lines } = captureWrite();
    const code = await runInstallWorkflow(
      ["--tree-repo", "acme/tree"],
      { cwd: tmp.path, write },
    );
    expect(code).toBe(0);
    const target = join(tmp.path, ".github/workflows/first-tree-sync.yml");
    expect(existsSync(target)).toBe(true);
    const body = readFileSync(target, "utf-8");
    expect(body).toContain("persist-credentials: false");
    expect(body).toContain('tree_repo_url="https://github.com/acme/tree.git"');
    expect(body).toContain('if GIT_TERMINAL_PROMPT=0 GIT_ASKPASS= SSH_ASKPASS= git');
    expect(body).toContain('askpass_script="$RUNNER_TEMP/first-tree-git-askpass.sh"');
    expect(lines.some((l) => l.includes("wrote"))).toBe(true);
    expect(lines.some((l) => l.includes("TREE_REPO_TOKEN"))).toBe(true);
    expect(lines.some((l) => l.includes("ANTHROPIC_API_KEY"))).toBe(true);
  });

  it("refuses to overwrite without --force", async () => {
    const tmp = useTmpDir();
    const { write } = captureWrite();
    await runInstallWorkflow(
      ["--tree-repo", "acme/tree"],
      { cwd: tmp.path, write },
    );
    const { write: write2, lines: lines2 } = captureWrite();
    const code = await runInstallWorkflow(
      ["--tree-repo", "acme/tree"],
      { cwd: tmp.path, write: write2 },
    );
    expect(code).toBe(1);
    expect(lines2.some((l) => l.includes("already exists"))).toBe(true);
  });

  it("overwrites when --force is passed", async () => {
    const tmp = useTmpDir();
    const { write } = captureWrite();
    await runInstallWorkflow(
      ["--tree-repo", "acme/tree"],
      { cwd: tmp.path, write },
    );
    const { write: write2 } = captureWrite();
    const code = await runInstallWorkflow(
      ["--tree-repo", "other/tree", "--force"],
      { cwd: tmp.path, write: write2 },
    );
    expect(code).toBe(0);
    const body = readFileSync(
      join(tmp.path, ".github/workflows/first-tree-sync.yml"),
      "utf-8",
    );
    expect(body).toContain('tree_repo_url="https://github.com/other/tree.git"');
  });

  it("prints yaml to stdout and does not write in --dry-run", async () => {
    const tmp = useTmpDir();
    const { write, lines } = captureWrite();
    const code = await runInstallWorkflow(
      ["--tree-repo", "acme/tree", "--dry-run"],
      { cwd: tmp.path, write },
    );
    expect(code).toBe(0);
    expect(existsSync(join(tmp.path, ".github/workflows/first-tree-sync.yml")))
      .toBe(false);
    expect(lines.some((l) => l.includes("https://github.com/acme/tree.git")))
      .toBe(true);
    expect(lines.some((l) => l.includes("dry-run"))).toBe(true);
  });

  it("rejects missing --tree-repo", async () => {
    const tmp = useTmpDir();
    const { write, lines } = captureWrite();
    const code = await runInstallWorkflow([], { cwd: tmp.path, write });
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("--tree-repo"))).toBe(true);
  });

  it("rejects a malformed tree-repo slug", async () => {
    const tmp = useTmpDir();
    const { write, lines } = captureWrite();
    const code = await runInstallWorkflow(
      ["--tree-repo", "https://github.com/acme/tree"],
      { cwd: tmp.path, write },
    );
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("owner/name"))).toBe(true);
  });

  it("prints usage for --help", async () => {
    const { write, lines } = captureWrite();
    const code = await runInstallWorkflow(["--help"], { write });
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("install-workflow"))).toBe(true);
    expect(INSTALL_WORKFLOW_USAGE).toContain("install-workflow");
  });
});

describe("gardener dispatcher routes install-workflow", () => {
  it("first-tree gardener install-workflow --help exits 0", async () => {
    const { write, lines } = captureWrite();
    const code = await runGardener(["install-workflow", "--help"], write);
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("install-workflow"))).toBe(true);
  });
});
