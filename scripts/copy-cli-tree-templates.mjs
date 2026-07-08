import { existsSync, statSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Copy the `first-tree tree init` scaffold `.ejs` templates into the CLI's
// bundle so the published binary can read them at runtime. Runs AFTER
// `copy-client-runtime-templates.mjs apps/cli` (which rm's + repopulates
// `dist/templates/` with the client briefing template), so this only ADDS files
// and must not remove the directory.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(repoRoot, "apps/cli/src/commands/tree/templates");
const targetDir = resolve(repoRoot, "apps/cli/dist/templates");

if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
  throw new Error(`CLI tree templates source is missing: ${sourceDir}`);
}

await mkdir(targetDir, { recursive: true });
await cp(sourceDir, targetDir, {
  recursive: true,
  filter: (source) => statSync(source).isDirectory() || source.endsWith(".ejs"),
});
