import { readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = resolve(import.meta.dirname, "..");

const SKIP = new Set([
  // Browser entrypoint; it intentionally touches document at module load.
  "main.tsx",
  // CSS is not a JavaScript module in the Node test environment.
  "index.css",
]);

function sourceModules(dir: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const absolute = resolve(dir, name);
    const rel = relative(srcRoot, absolute);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      if (name === "__tests__") continue;
      entries.push(...sourceModules(absolute));
      continue;
    }
    if (SKIP.has(rel)) continue;
    if (!/\.(ts|tsx)$/.test(name)) continue;
    entries.push(absolute);
  }
  return entries;
}

describe("web source modules", () => {
  it("load without browser-only module side effects", async () => {
    const modules = sourceModules(srcRoot);
    const loaded: string[] = [];
    for (const mod of modules) {
      await import(pathToFileURL(mod).href);
      loaded.push(relative(srcRoot, mod));
    }

    expect(loaded).toContain("app.tsx");
    expect(loaded.length).toBeGreaterThan(150);
  }, 30_000);
});
