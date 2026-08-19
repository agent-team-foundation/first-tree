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
const canonicalPolicy = resolve(repoRoot, "packages/client/src/runtime/assets/context-tree-policy.md");
const canonicalWriteRouting = resolve(repoRoot, "packages/client/src/runtime/assets/context-tree-write-routing.md");
const targetDir = resolve(repoRoot, packageDirArg, "dist/templates");
const runtimeAssetsDir = resolve(repoRoot, packageDirArg, "dist/runtime-assets");

if (!existsSync(requiredTemplate) || !statSync(requiredTemplate).isFile()) {
  throw new Error(`Required client runtime template is missing: ${requiredTemplate}`);
}
if (!existsSync(canonicalPolicy) || !statSync(canonicalPolicy).isFile()) {
  throw new Error(`Canonical Context Tree policy is missing: ${canonicalPolicy}`);
}
if (!existsSync(canonicalWriteRouting) || !statSync(canonicalWriteRouting).isFile()) {
  throw new Error(`Canonical Context Tree write routing contract is missing: ${canonicalWriteRouting}`);
}

if (existsSync(targetDir)) {
  rmSync(targetDir, { recursive: true, force: true });
}
if (existsSync(runtimeAssetsDir)) {
  rmSync(runtimeAssetsDir, { recursive: true, force: true });
}

await mkdir(targetDir, { recursive: true });
await cp(sourceDir, targetDir, {
  recursive: true,
  filter: (source) => statSync(source).isDirectory() || source.endsWith(".ejs"),
});
await mkdir(runtimeAssetsDir, { recursive: true });
await cp(canonicalPolicy, resolve(runtimeAssetsDir, "context-tree-policy.md"));
await cp(canonicalWriteRouting, resolve(runtimeAssetsDir, "context-tree-write-routing.md"));

const deepseekCordisSource = resolve(repoRoot, "packages/client/src/providers/deepseek-harness/cordis.yml");
if (!existsSync(deepseekCordisSource) || !statSync(deepseekCordisSource).isFile()) {
  throw new Error(`DeepSeek cordis template is missing: ${deepseekCordisSource}`);
}
// Stable runtime-asset location shared with agent-briefing discovery
// (`./runtime-assets` / `../runtime-assets` from bundled chunks).
await cp(deepseekCordisSource, resolve(runtimeAssetsDir, "deepseek-harness-cordis.yml"));
