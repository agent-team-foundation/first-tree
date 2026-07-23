import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("published CLI install migration", () => {
  it("ships the legacy github-scan cleanup in the postinstall payload", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      files?: string[];
      scripts?: { postinstall?: string };
    };

    expect(packageJson.files).toContain("scripts/retire-legacy-github-scan-launchd.mjs");
    expect(packageJson.scripts?.postinstall).toContain("node scripts/retire-legacy-github-scan-launchd.mjs");
  });

  it("executes the freshly installed CLI in cleanup-only mode", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-postinstall-migration-"));
    try {
      const scriptsDir = join(root, "scripts");
      const cliDir = join(root, "dist", "cli");
      const marker = join(root, "marker");
      mkdirSync(scriptsDir, { recursive: true });
      mkdirSync(cliDir, { recursive: true });
      copyFileSync(
        new URL("../../scripts/retire-legacy-github-scan-launchd.mjs", import.meta.url),
        join(scriptsDir, "retire.mjs"),
      );
      writeFileSync(
        join(cliDir, "index.mjs"),
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, process.env.FIRST_TREE_LEGACY_GITHUB_SCAN_ONLY ?? "");\n`,
      );

      const result = spawnSync(process.execPath, [join(scriptsDir, "retire.mjs")], {
        cwd: root,
        encoding: "utf-8",
        env: { ...process.env, FIRST_TREE_MIGRATION_TEST: "1" },
      });

      expect(result.status).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf-8")).toBe("1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
