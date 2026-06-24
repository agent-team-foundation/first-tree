#!/usr/bin/env node
"use strict";

function parseNodeVersion(version) {
  var parts = String(version || "").split(".");
  return {
    major: Number(parts[0]),
    minor: Number(parts[1] || 0),
    patch: Number(parts[2] || 0),
  };
}

function isSupportedNode(version) {
  var parsed = parseNodeVersion(version);
  if (!Number.isFinite(parsed.major) || !Number.isFinite(parsed.minor) || !Number.isFinite(parsed.patch)) {
    return false;
  }
  if (parsed.major > 18) return true;
  if (parsed.major < 18) return false;
  if (parsed.minor > 14) return true;
  if (parsed.minor < 14) return false;
  return parsed.patch >= 1;
}

// biome-ignore lint/complexity/useOptionalChain: keep the preflight parseable on old Node versions.
if (!isSupportedNode(process.versions && process.versions.node)) {
  console.error("First Tree requires Node.js >=18.14.1.");
  console.error("Please upgrade Node.js, then run this command again.");
  process.exit(1);
}

var loadCli = new Function("specifier", "return import(specifier)");
loadCli("../dist/cli/index.mjs").catch(function handleCliLoadError(error) {
  // biome-ignore lint/complexity/useOptionalChain: keep the wrapper parseable on old Node versions.
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
