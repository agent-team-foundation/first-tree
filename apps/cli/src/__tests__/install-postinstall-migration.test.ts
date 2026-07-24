import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_URL = new URL("../../scripts/retire-legacy-github-scan-launchd.mjs", import.meta.url);

function stageInstallLayout(root: string): { script: string; marker: string } {
  const scriptsDir = join(root, "scripts");
  const cliDir = join(root, "dist", "cli");
  const marker = join(root, "marker.json");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(cliDir, { recursive: true });
  const script = join(scriptsDir, "retire.mjs");
  copyFileSync(SCRIPT_URL, script);
  writeFileSync(
    join(cliDir, "index.mjs"),
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({\n` +
      `  cleanupOnly: process.env.FIRST_TREE_LEGACY_GITHUB_SCAN_ONLY ?? null,\n` +
      `  serviceMode: process.env.FIRST_TREE_SERVICE_MODE ?? null,\n` +
      `  argv: process.argv.slice(2),\n` +
      `}));\n`,
  );
  return { script, marker };
}

describe("published CLI install migration", () => {
  it("ships the legacy github-scan cleanup in the postinstall payload", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      files?: string[];
      scripts?: { postinstall?: string };
    };

    expect(packageJson.files).toContain("scripts/retire-legacy-github-scan-launchd.mjs");
    expect(packageJson.scripts?.postinstall).toContain("node scripts/retire-legacy-github-scan-launchd.mjs");
  });

  it("launches the freshly installed CLI in cleanup-only mode", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-postinstall-"));
    try {
      const { script, marker } = stageInstallLayout(root);

      const result = spawnSync(process.execPath, [script], {
        cwd: root,
        encoding: "utf-8",
        env: { ...process.env, FIRST_TREE_SERVICE_MODE: "1" },
      });

      expect(result.status).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(JSON.parse(readFileSync(marker, "utf-8"))).toEqual({
        cleanupOnly: "1",
        // An inherited service-mode marker must not leak into the child.
        serviceMode: "",
        argv: ["daemon", "ensure-service"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stays inert inside the source monorepo", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-postinstall-src-"));
    try {
      const { script, marker } = stageInstallLayout(root);
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
      mkdirSync(join(root, "apps", "cli"), { recursive: true });

      const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf-8" });

      expect(result.status).toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
