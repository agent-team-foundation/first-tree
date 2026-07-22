import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("agent briefing template assets", () => {
  it("copy script materializes the EJS template in the package dist/templates layout", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "first-tree-template-assets-"));
    try {
      const relativePackageDir = relative(repoRoot, tempRoot);

      execFileSync("node", ["scripts/copy-client-runtime-templates.mjs", relativePackageDir], {
        cwd: repoRoot,
        stdio: "pipe",
      });

      const copiedTemplate = join(tempRoot, "dist", "templates", "agent-briefing.ejs");
      expect(existsSync(copiedTemplate)).toBe(true);

      const copiedSource = readFileSync(copiedTemplate, "utf8");
      const sourceTemplate = readFileSync(
        join(repoRoot, "packages", "client", "src", "runtime", "templates", "agent-briefing.ejs"),
        "utf8",
      );

      expect(copiedSource).toBe(sourceTemplate);
      expect(copiedSource).toContain("# Working in First Tree (First Tree Managed)");
      expect(copiedSource).toContain("## GitLab Working Posture");
      expect(copiedSource).toContain("## GitLab Entity Attention");
      expect(copiedSource).toContain("gitlab follow <url>");
      expect(copiedSource).toContain("inbound-only and may return pending or active");
      expect(copiedSource).not.toContain("first-tree-gitlab");
      expect(copiedSource).not.toContain("glab mr subscribe <iid-or-branch>");
      expect(copiedSource).toContain("## Context Tree Policy");
      expect(copiedSource).toContain("# Skills (First Tree Managed)");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
