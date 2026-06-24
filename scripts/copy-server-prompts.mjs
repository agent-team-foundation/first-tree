import { existsSync, statSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(repoRoot, "packages/server/src/prompts");
const targetDir = resolve(repoRoot, "packages/server/dist/prompts");

if (!existsSync(sourceDir)) {
  process.exit(0);
}

await mkdir(targetDir, { recursive: true });
await cp(sourceDir, targetDir, {
  recursive: true,
  filter: (source) => statSync(source).isDirectory() || source.endsWith(".ejs"),
});
