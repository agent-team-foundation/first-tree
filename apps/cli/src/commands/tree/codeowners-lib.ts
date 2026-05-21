import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const FRONTMATTER_RE = /^---\s*\n(.*?)\n---/su;
const OWNERS_RE = /^owners:\s*\[([^\]]*)\]/mu;
const SKIP = new Set(["node_modules", "__pycache__"]);

export function parseOwners(path: string): string[] | null {
  let text: string;

  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null;
  }

  const frontmatter = text.match(FRONTMATTER_RE);
  if (!frontmatter) {
    return null;
  }

  const owners = frontmatter[1].match(OWNERS_RE);
  if (!owners) {
    return null;
  }

  const raw = owners[1].trim();
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((owner) => owner.trim())
    .filter(Boolean);
}

export function resolveNodeOwners(
  folder: string,
  treeRoot: string,
  cache: Map<string, string[]>,
): string[] {
  const cached = cache.get(folder);
  if (cached !== undefined) {
    return cached;
  }

  const nodePath = join(folder, "NODE.md");
  const owners = parseOwners(nodePath);

  let resolved: string[];
  if (owners === null || owners.length === 0) {
    const parent = dirname(folder);
    resolved =
      parent.length >= treeRoot.length && parent !== folder
        ? resolveNodeOwners(parent, treeRoot, cache)
        : [];
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
  const rel = relative(treeRoot, path).replace(/\\/gu, "/");

  try {
    if (statSync(path).isDirectory()) {
      return `/${rel}/`;
    }
  } catch {
    // Ignore and fall back to file-style path.
  }

  return `/${rel}`;
}

export function formatOwners(owners: string[]): string {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const owner of owners) {
    const normalized = owner.replace(/^@+/u, "");

    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(`@${normalized}`);
  }

  return result.join(" ");
}

export function collectEntries(treeRoot: string): Array<[string, string[]]> {
  const nodeCache = new Map<string, string[]>();
  const entries: Array<[string, string[]]> = [];

  function walk(dir: string): void {
    let names: string[];

    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }

    for (const name of names) {
      const fullPath = join(dir, name);
      const parts = relative(treeRoot, fullPath).split("/");

      if (parts.some((part) => SKIP.has(part) || part.startsWith("."))) {
        continue;
      }

      try {
        if (!statSync(fullPath).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }

      if (!existsSync(join(fullPath, "NODE.md"))) {
        walk(fullPath);
        continue;
      }

      const folderOwners = resolveNodeOwners(fullPath, treeRoot, nodeCache);
      if (folderOwners.length > 0 && !isWildcard(folderOwners)) {
        entries.push([codeownersPath(fullPath, treeRoot), folderOwners]);
      }

      for (const child of readdirSync(fullPath).sort()) {
        const childPath = join(fullPath, child);

        try {
          if (!statSync(childPath).isFile() || !child.endsWith(".md") || child === "NODE.md") {
            continue;
          }
        } catch {
          continue;
        }

        const leafOwners = parseOwners(childPath);
        if (isWildcard(leafOwners)) {
          continue;
        }

        if (leafOwners && leafOwners.length > 0) {
          const inheritedOwners = folderOwners.filter((owner) => owner !== "*");
          const combined = [
            ...inheritedOwners,
            ...leafOwners.filter((owner) => !inheritedOwners.includes(owner)),
          ];

          if (combined.length > 0) {
            entries.push([codeownersPath(childPath, treeRoot), combined]);
          }
        }
      }

      walk(fullPath);
    }
  }

  walk(treeRoot);

  const rootOwners = resolveNodeOwners(treeRoot, treeRoot, nodeCache);
  for (const child of readdirSync(treeRoot).sort()) {
    const childPath = join(treeRoot, child);

    try {
      if (!statSync(childPath).isFile() || !child.endsWith(".md") || child === "NODE.md") {
        continue;
      }
    } catch {
      continue;
    }

    const leafOwners = parseOwners(childPath);
    if (isWildcard(leafOwners)) {
      continue;
    }

    if (leafOwners && leafOwners.length > 0) {
      const combined = [
        ...rootOwners,
        ...leafOwners.filter((owner) => !rootOwners.includes(owner)),
      ];
      entries.push([codeownersPath(childPath, treeRoot), combined]);
    }
  }

  if (rootOwners.length > 0) {
    entries.unshift(["/*", rootOwners]);
  }

  return entries;
}

export function generateCodeowners(
  treeRoot: string,
  options?: { check?: boolean; alwaysInclude?: string[] },
): number {
  const check = options?.check ?? false;
  const alwaysInclude = options?.alwaysInclude ?? [];
  const entries = collectEntries(treeRoot);
  const codeownersFile = join(treeRoot, ".github", "CODEOWNERS");
  const lines = ["# Auto-generated from Context Tree. Do not edit manually.", ""];

  for (const [pattern, owners] of entries) {
    const merged = alwaysInclude.length > 0 ? [...owners, ...alwaysInclude] : owners;

    if (merged.length > 0) {
      lines.push(`${pattern.padEnd(50)} ${formatOwners(merged)}`);
    }
  }

  lines.push("");
  const content = lines.join("\n");

  if (check) {
    const current = existsSync(codeownersFile) ? readFileSync(codeownersFile, "utf-8") : null;
    if (current === content) {
      console.log("CODEOWNERS is up-to-date.");
      return 0;
    }

    console.log(
      "CODEOWNERS is out-of-date. Run: npx -p first-tree first-tree tree codeowners",
    );
    return 1;
  }

  mkdirSync(dirname(codeownersFile), { recursive: true });
  writeFileSync(codeownersFile, content);
  console.log(`Wrote ${relative(treeRoot, codeownersFile)}`);
  return 0;
}
