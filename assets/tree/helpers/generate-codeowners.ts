import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

const FRONTMATTER_RE = /^---\s*\n(.*?)\n---/s;
const OWNERS_RE = /^owners:\s*\[([^\]]*)\]/m;
const SKIP = new Set(["node_modules", "__pycache__"]);

export function parseOwners(path: string): string[] | null {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const fm = text.match(FRONTMATTER_RE);
  if (!fm) return null;
  const m = fm[1].match(OWNERS_RE);
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw) return []; // owners: [] — will inherit
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function resolveNodeOwners(
  folder: string,
  treeRoot: string,
  cache: Map<string, string[]>,
): string[] {
  if (cache.has(folder)) return cache.get(folder)!;

  const nodeMd = join(folder, "NODE.md");
  const owners = parseOwners(nodeMd);

  let resolved: string[];
  if (owners === null || owners.length === 0) {
    const parent = dirname(folder);
    if (parent.length >= treeRoot.length && parent !== folder) {
      resolved = resolveNodeOwners(parent, treeRoot, cache);
    } else {
      resolved = [];
    }
  } else {
    resolved = owners;
  }

  cache.set(folder, resolved);
  return resolved;
}

function isWildcard(owners: string[] | null): boolean {
  return owners !== null && owners.includes("*");
}

function codeownersPath(path: string, treeRoot: string): string {
  const r = relative(treeRoot, path).replace(/\\/g, "/");
  try {
    if (statSync(path).isDirectory()) return `/${r}/`;
  } catch {
    // not a dir
  }
  return `/${r}`;
}

export function formatOwners(owners: string[]): string {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const o of owners) {
    // Strip leading @ if present, then add it — prevents @@double-prefix
    const normalized = o.replace(/^@+/, "");
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(`@${normalized}`);
    }
  }
  return result.join(" ");
}

export function collectEntries(
  root: string,
): [string, string[]][] {
  const nodeCache = new Map<string, string[]>();
  const entries: [string, string[]][] = [];

  function walk(dir: string): void {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      const parts = relative(root, full).split("/");
      if (parts.some((p) => SKIP.has(p) || p.startsWith("."))) continue;
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!existsSync(join(full, "NODE.md"))) {
        walk(full);
        continue;
      }

      const folderOwners = resolveNodeOwners(full, root, nodeCache);

      if (folderOwners.length > 0 && !isWildcard(folderOwners)) {
        entries.push([codeownersPath(full, root), folderOwners]);
      }

      // Leaf files
      for (const child of readdirSync(full).sort()) {
        const childPath = join(full, child);
        try {
          if (
            !statSync(childPath).isFile() ||
            !child.endsWith(".md") ||
            child === "NODE.md"
          )
            continue;
        } catch {
          continue;
        }
        const leafOwners = parseOwners(childPath);
        if (isWildcard(leafOwners)) continue;
        if (leafOwners && leafOwners.length > 0) {
          const nonWildcardFolder = folderOwners.filter((o) => o !== "*");
          const combined = [
            ...nonWildcardFolder,
            ...leafOwners.filter((o) => !nonWildcardFolder.includes(o)),
          ];
          if (combined.length > 0) {
            entries.push([codeownersPath(childPath, root), combined]);
          }
        }
      }

      walk(full);
    }
  }

  walk(root);

  // Root-level leaf files
  const rootOwners = resolveNodeOwners(root, root, nodeCache);
  for (const child of readdirSync(root).sort()) {
    const childPath = join(root, child);
    try {
      if (
        !statSync(childPath).isFile() ||
        !child.endsWith(".md") ||
        child === "NODE.md"
      )
        continue;
    } catch {
      continue;
    }
    const leafOwners = parseOwners(childPath);
    if (isWildcard(leafOwners)) continue;
    if (leafOwners && leafOwners.length > 0) {
      const combined = [
        ...rootOwners,
        ...leafOwners.filter((o) => !rootOwners.includes(o)),
      ];
      entries.push([codeownersPath(childPath, root), combined]);
    }
  }

  // Root entry (catch-all)
  if (rootOwners.length > 0) {
    entries.unshift(["/*", rootOwners]);
  }

  return entries;
}

export function generate(
  treeRoot: string,
  opts?: { check?: boolean },
): number {
  const check = opts?.check ?? false;
  const entries = collectEntries(treeRoot);
  const codeownersFile = join(treeRoot, ".github", "CODEOWNERS");

  const lines = ["# Auto-generated from Context Tree. Do not edit manually.", ""];
  for (const [pattern, owners] of entries) {
    if (owners.length > 0) {
      lines.push(`${pattern.padEnd(50)} ${formatOwners(owners)}`);
    }
  }
  lines.push(""); // trailing newline
  const content = lines.join("\n");

  if (check) {
    if (existsSync(codeownersFile) && readFileSync(codeownersFile, "utf-8") === content) {
      console.log("CODEOWNERS is up-to-date.");
      return 0;
    }
    console.log(
      "CODEOWNERS is out-of-date. Run: npx first-tree generate-codeowners",
    );
    return 1;
  }

  mkdirSync(dirname(codeownersFile), { recursive: true });
  writeFileSync(codeownersFile, content);
  console.log(`Wrote ${relative(treeRoot, codeownersFile)}`);
  return 0;
}
