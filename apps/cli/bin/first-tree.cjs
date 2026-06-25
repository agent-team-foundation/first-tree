#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const cli = join(__dirname, "..", "dist", "cli", "index.mjs");
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
