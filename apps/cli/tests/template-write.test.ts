import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readTreeState } from "../src/commands/tree/binding-state.js";
import { bootstrapTreeRoot } from "../src/commands/tree/bootstrap.js";
import { readCurrentCliVersion } from "../src/commands/tree/cli-version.js";
import {
  ensureTier0RuleLayer,
  VALIDATE_WORKFLOW_TEMPLATE_VERSION,
  validateWorkflowPath,
} from "../src/commands/tree/rule-layer.js";
import { parseTemplateVersion, writeTemplatedFile } from "../src/commands/tree/template-write.js";
import { readTreeIdentityContract } from "../src/commands/tree/tree-identity.js";
import { upgradeTargetRoot } from "../src/commands/tree/upgrade.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("writeTemplatedFile", () => {
  it("writes a missing template file and records its version marker", () => {
    const root = makeTempDir("first-tree-template-write-");
    const path = join(root, "validate.yml");

    const result = writeTemplatedFile(path, "# first-tree-template-version: 1\nname: Validate\n", {
      version: 1,
    });

    expect(result).toEqual({ kind: "written" });
    expect(existsSync(path)).toBe(true);
    expect(parseTemplateVersion(path)).toBe(1);
  });

  it("skips existing files without a managed marker", () => {
    const root = makeTempDir("first-tree-template-custom-");
    const path = join(root, "validate.yml");
    writeFileSync(path, "name: Custom validate\n");

    const result = writeTemplatedFile(path, "# first-tree-template-version: 1\nname: Validate\n", {
      version: 1,
    });

    expect(result).toEqual({ kind: "skipped-existing-no-marker" });
    expect(readFileSync(path, "utf8")).toBe("name: Custom validate\n");
  });

  it("skips files when the installed version matches or exceeds the bundled template", () => {
    const root = makeTempDir("first-tree-template-same-");
    const path = join(root, "validate.yml");
    writeFileSync(path, "# first-tree-template-version: 2\nname: Validate\n");

    const result = writeTemplatedFile(path, "# first-tree-template-version: 1\nname: Validate\n", {
      version: 1,
    });

    expect(result).toEqual({ kind: "skipped-same-version" });
    expect(parseTemplateVersion(path)).toBe(2);
  });

  it("flags older managed templates for manual upgrade instead of overwriting them", () => {
    const root = makeTempDir("first-tree-template-upgrade-");
    const path = join(root, "validate.yml");
    writeFileSync(path, "# first-tree-template-version: 0\nname: Old validate\n");

    const result = writeTemplatedFile(path, "# first-tree-template-version: 1\nname: Validate\n", {
      version: 1,
    });

    expect(result).toEqual({
      kind: "needs-upgrade",
      currentVersion: 0,
      templateVersion: 1,
    });
    expect(readFileSync(path, "utf8")).toContain("name: Old validate");
  });
});

describe("tree rule-layer templates", () => {
  it("bootstraps new tree roots with the Tier 0 validate workflow", () => {
    const root = makeTempDir("first-tree-bootstrap-template-");

    const summary = bootstrapTreeRoot(root, { treeMode: "shared" });

    const workflowPath = validateWorkflowPath(root);
    expect(summary.tier0RuleLayer.validate).toEqual({ kind: "written" });
    expect(existsSync(workflowPath)).toBe(true);
    expect(readFileSync(workflowPath, "utf8")).toContain(
      `# first-tree-template-version: ${VALIDATE_WORKFLOW_TEMPLATE_VERSION}`,
    );
    expect(readFileSync(workflowPath, "utf8")).toContain(
      `run: npx -p first-tree@${readCurrentCliVersion()} first-tree tree verify`,
    );
  });

  it("persists tree identity to .first-tree/tree.json so verify and upgrade can resolve it", () => {
    const root = makeTempDir("first-tree-bootstrap-identity-");

    bootstrapTreeRoot(root, { treeMode: "shared" });

    const state = readTreeState(root);
    expect(state).not.toBeNull();
    expect(state?.treeMode).toBe("shared");
    expect(state?.treeRepoName.length ?? 0).toBeGreaterThan(0);
    expect(state?.treeId.length ?? 0).toBeGreaterThan(0);

    const identity = readTreeIdentityContract(root);
    expect(identity).toBeDefined();
    expect(identity?.treeRepoName).toBe(state?.treeRepoName);
    expect(identity?.treeMode).toBe("shared");
  });

  it("upgrades existing tree roots by adding the missing Tier 0 validate workflow", () => {
    const root = makeTempDir("first-tree-upgrade-template-");
    mkdirSync(join(root, ".first-tree"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "# Agents\n");
    writeFileSync(join(root, "CLAUDE.md"), "# Claude\n");
    writeFileSync(join(root, ".git"), "gitdir: /tmp/tree\n");
    writeFileSync(
      join(root, ".first-tree", "tree.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        treeId: "context-tree",
        treeMode: "shared",
        treeRepoName: "context-tree",
      })}\n`,
    );

    const summary = upgradeTargetRoot(root);

    expect(summary.tier0RuleLayer?.validate).toEqual({ kind: "written" });
    expect(existsSync(validateWorkflowPath(root))).toBe(true);
    expect(parseTemplateVersion(validateWorkflowPath(root))).toBe(VALIDATE_WORKFLOW_TEMPLATE_VERSION);
  });

  it("does not overwrite custom validate workflows when re-ensuring Tier 0", () => {
    const root = makeTempDir("first-tree-custom-template-");
    const workflowPath = validateWorkflowPath(root);
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(workflowPath, "name: My custom validate\n");

    const summary = ensureTier0RuleLayer(root);

    expect(summary.validate).toEqual({ kind: "skipped-existing-no-marker" });
    expect(readFileSync(workflowPath, "utf8")).toBe("name: My custom validate\n");
  });

  it("surfaces manual upgrades for older managed validate workflows", () => {
    const root = makeTempDir("first-tree-managed-template-upgrade-");
    const workflowPath = validateWorkflowPath(root);
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(workflowPath, "# first-tree-template-version: 1\nname: Validate Tree\n");

    const summary = ensureTier0RuleLayer(root);

    expect(summary.validate).toEqual({
      kind: "needs-upgrade",
      currentVersion: 1,
      templateVersion: VALIDATE_WORKFLOW_TEMPLATE_VERSION,
    });
  });
});
