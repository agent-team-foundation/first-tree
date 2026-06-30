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
      expect(readFileSync(copiedTemplate, "utf8")).toContain("generatedBannerBlock");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
