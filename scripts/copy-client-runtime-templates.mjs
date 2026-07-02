import { existsSync, rmSync, statSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirArg = process.argv[2];

if (!packageDirArg) {
  throw new Error("Usage: node scripts/copy-client-runtime-templates.mjs <package-dir>");
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(repoRoot, "packages/client/src/runtime/templates");
const requiredTemplate = resolve(sourceDir, "agent-briefing.ejs");
const targetDir = resolve(repoRoot, packageDirArg, "dist/templates");

if (!existsSync(requiredTemplate) || !statSync(requiredTemplate).isFile()) {
  throw new Error(`Required client runtime template is missing: ${requiredTemplate}`);
}

if (existsSync(targetDir)) {
  rmSync(targetDir, { recursive: true, force: true });
}

await mkdir(targetDir, { recursive: true });
await cp(sourceDir, targetDir, {
  recursive: true,
  filter: (source) => statSync(source).isDirectory() || source.endsWith(".ejs"),
});
