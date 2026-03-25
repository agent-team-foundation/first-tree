/**
 * Post-build script: embed runtime assets into dist/ for npm publishing.
 *
 * - dist/drizzle/  ← packages/server/drizzle/ (SQL migrations + journal)
 * - dist/web/      ← packages/web/dist/        (static frontend assets)
 */

import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

// Embed database migrations
const migrSrc = resolve(root, "..", "server", "drizzle");
const migrDst = resolve(dist, "drizzle");
if (existsSync(migrSrc)) {
  cpSync(migrSrc, migrDst, { recursive: true });
  console.log("  Embedded drizzle migrations → dist/drizzle/");
} else {
  console.warn("  ⚠ server/drizzle/ not found, skipping migrations embed");
}

// Embed web frontend
const webSrc = resolve(root, "..", "web", "dist");
const webDst = resolve(dist, "web");
if (existsSync(webSrc)) {
  cpSync(webSrc, webDst, { recursive: true });
  console.log("  Embedded web dist → dist/web/");
} else {
  console.warn("  ⚠ web/dist/ not found, skipping web embed (build web first)");
}
