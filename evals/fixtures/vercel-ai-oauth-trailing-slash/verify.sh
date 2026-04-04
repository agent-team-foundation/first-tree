#!/usr/bin/env bash
set -euo pipefail

# Verify the trailing-slash bug in the OAuth resource parameter is fixed.
#
# The original bug: resource.href is used directly as the OAuth resource
# parameter, but URL.href adds a trailing slash to root URLs
# (https://example.com → https://example.com/), causing exact-match
# failures with auth servers.
#
# We check that the code no longer uses bare resource.href for the
# resource parameter, or that it normalizes the URL to strip trailing slashes.

node -e "
const fs = require('fs');

const oauthPath = 'packages/mcp/src/tool/oauth.ts';
let content;
try {
  content = fs.readFileSync(oauthPath, 'utf-8');
} catch (e) {
  console.log('FAIL: Cannot read ' + oauthPath);
  process.exit(1);
}

// Count how many times the bare pattern resource.href appears in
// searchParams.set or params.set calls for the 'resource' key.
// Original buggy code has 3 such occurrences.
const bareHrefPattern = /(?:params|searchParams)\.set\(\s*['\"]resource['\"]\s*,\s*resource\.href\s*\)/g;
const bareMatches = content.match(bareHrefPattern) || [];

if (bareMatches.length >= 3) {
  console.log('FAIL: oauth.ts still has ' + bareMatches.length + ' bare resource.href usages (unfixed)');
  process.exit(1);
}

// Check that some form of URL normalization or trailing-slash handling exists.
// Accept any of these signals:
const signals = [
  'trailing',
  'stripTrailingSlash',
  'replace(/\\\\/\$/',    // regex to strip trailing slash
  'endsWith',
  'slice(0, -1)',
  'pathname',
  'origin',
  'resourceUrl',          // extracted/normalized variable
  'normaliz',             // normalize/normalization
  'replace(.*\\/$',       // regex trailing slash strip
];

let found = false;
for (const sig of signals) {
  if (content.includes(sig)) {
    console.log('PASS: oauth.ts contains URL normalization signal: ' + sig);
    found = true;
    break;
  }
}

// Also check util files for helper functions
const utilFiles = [
  'packages/mcp/src/util/oauth-util.ts',
  'packages/mcp/src/tool/oauth-util.ts',
];
for (const file of utilFiles) {
  try {
    const utilContent = fs.readFileSync(file, 'utf-8');
    for (const sig of signals) {
      if (utilContent.includes(sig)) {
        console.log('PASS: ' + file + ' contains normalization signal: ' + sig);
        found = true;
        break;
      }
    }
  } catch (e) { /* file doesn't exist */ }
  if (found) break;
}

if (!found && bareMatches.length > 0) {
  console.log('FAIL: No trailing slash handling found and still has ' + bareMatches.length + ' bare resource.href usages');
  process.exit(1);
}

if (!found && bareMatches.length === 0) {
  // resource.href was replaced with something else — that counts as a fix
  console.log('PASS: resource.href no longer used directly for resource parameter');
}

console.log('All OAuth trailing slash checks passed.');
"
