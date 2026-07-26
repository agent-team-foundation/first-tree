#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const testRoots = ["src/__tests__", "tests"];
const singletonFiles = new Set([
  "src/__tests__/client-runtime-context-tree.test.ts",
  "src/__tests__/login-command.test.ts",
  "src/__tests__/service-install-core.test.ts",
  "src/__tests__/task-scheduler-operations.test.ts",
  "src/__tests__/update-portable-install.test.ts",
  "tests/portable-s3-scripts.test.ts",
]);

const batchSize = Number.parseInt(process.env.FIRST_TREE_CLI_TEST_BATCH_SIZE ?? "8", 10);
const maxBatchSize = Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 8;
const passthroughArgs = process.argv.slice(2);
const vitestBin = process.platform === "win32" ? "vitest.cmd" : "vitest";

function hasGitAncestor(path) {
  let current = resolve(path);
  while (true) {
    if (existsSync(join(current, ".git"))) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

function resolveTempRoot() {
  const candidates = [
    process.env.FIRST_TREE_CLI_TEST_TMPDIR,
    process.env.RUNNER_TEMP,
    join(homedir(), ".cache", "first-tree", "cli-tests"),
    tmpdir(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      mkdirSync(candidate, { recursive: true });
      if (!hasGitAncestor(candidate)) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return tmpdir();
}

function listTestFiles(root) {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.test\.[cm]?[jt]sx?$/.test(entry.name))
    .map((entry) => join(root, entry.name).replaceAll("\\", "/"));
}

function chunk(files, size) {
  const chunks = [];
  for (let index = 0; index < files.length; index += size) {
    chunks.push(files.slice(index, index + size));
  }
  return chunks;
}

const discoveredFiles = testRoots.flatMap(listTestFiles).sort();
const singletonBatches = discoveredFiles.filter((file) => singletonFiles.has(file)).map((file) => [file]);
const remainingBatches = chunk(
  discoveredFiles.filter((file) => !singletonFiles.has(file)),
  maxBatchSize,
);
const batches = [...singletonBatches, ...remainingBatches];
const tempRoot = resolveTempRoot();

for (const [index, files] of batches.entries()) {
  console.error(
    `[first-tree-dev test] batch ${index + 1}/${batches.length}: ${files.length} file${files.length === 1 ? "" : "s"}`,
  );
  const result = spawnSync(vitestBin, ["run", "--passWithNoTests", ...passthroughArgs, ...files], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TEMP: tempRoot,
      TMP: tempRoot,
      TMPDIR: tempRoot,
      VITEST_MAX_FORKS: process.env.VITEST_MAX_FORKS ?? "1",
    },
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
