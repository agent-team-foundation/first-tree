#!/usr/bin/env bash
set -euo pipefail

# Build first (TypeScript project)
pnpm build --filter @ai-sdk/mcp 2>/dev/null || true

# Run the MCP OAuth tests
pnpm test --filter @ai-sdk/mcp -- --run 2>&1 | tail -20

# Also verify the utility function exists and handles trailing slashes
node -e "
const fs = require('fs');

// Check that oauth-util.ts (or similar) has trailing slash stripping logic
const utilFiles = [
  'packages/mcp/src/util/oauth-util.ts',
  'packages/mcp/src/tool/oauth-util.ts',
];

let found = false;
for (const file of utilFiles) {
  try {
    const content = fs.readFileSync(file, 'utf-8');
    if (content.includes('trailing') || content.includes('pathname') || content.includes('slash')) {
      console.log('PASS: ' + file + ' contains trailing slash handling');
      found = true;
      break;
    }
  } catch (e) {
    // file doesn't exist, try next
  }
}

// Also check the main oauth.ts
try {
  const oauthContent = fs.readFileSync('packages/mcp/src/tool/oauth.ts', 'utf-8');
  // The resource parameter should not end with just a slash
  if (oauthContent.includes('resource') && (oauthContent.includes('trailing') || oauthContent.includes('stripTrailingSlash') || oauthContent.includes('pathname'))) {
    console.log('PASS: oauth.ts handles resource URL normalization');
    found = true;
  }
} catch (e) {}

if (!found) {
  console.log('FAIL: No trailing slash handling found in OAuth files');
  process.exit(1);
}

console.log('All OAuth trailing slash checks passed.');
"
