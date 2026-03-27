import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, posix } from "node:path";

const FRONTMATTER_RE = /^---\s*\n(.*?)\n---/s;
const OWNERS_RE = /^owners:\s*\[([^\]]*)\]/m;
const SOFT_LINKS_INLINE_RE = /^soft_links:\s*\[([^\]]*)\]/m;
const SOFT_LINKS_BLOCK_RE = /^soft_links:\s*\n((?:\s+-\s+.+\n?)+)/m;
const TITLE_RE = /^title:\s*['"]?(.+?)['"]?\s*$/m;
const GITHUB_USER_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const MD_LINK_RE = /\[.*?\]\(([^)]+\.md)\)/g;
const DOMAIN_LINK_RE = /\[(\w[\w-]*)\/?\]\((\w[\w-]*)\/NODE\.md\)/g;

const SKIP = new Set(["node_modules", "__pycache__"]);
const SKIP_FILES = new Set(["AGENT.md", "CLAUDE.md"]);
const MIN_BODY_LENGTH = 20;

export class Findings {
  errors: string[] = [];
  warnings: string[] = [];
  infos: string[] = [];

  error(msg: string): void {
    this.errors.push(msg);
  }
  warning(msg: string): void {
    this.warnings.push(msg);
  }
  info(msg: string): void {
    this.infos.push(msg);
  }
  hasErrors(): boolean {
    return this.errors.length > 0;
  }
  printReport(totalFiles: number): void {
    const all: [string, string][] = [
      ...this.errors.map((e): [string, string] => ["error", e]),
      ...this.warnings.map((w): [string, string] => ["warning", w]),
      ...this.infos.map((i): [string, string] => ["info", i]),
    ];
    if (all.length > 0) {
      const counts: string[] = [];
      if (this.errors.length) counts.push(`${this.errors.length} error(s)`);
      if (this.warnings.length) counts.push(`${this.warnings.length} warning(s)`);
      if (this.infos.length) counts.push(`${this.infos.length} info(s)`);
      console.log(`Found ${counts.join(", ")}:\n`);
      const icons: Record<string, string> = {
        error: "\u2717",
        warning: "\u26a0",
        info: "\u2139",
      };
      for (const [severity, msg] of all) {
        console.log(`  ${icons[severity]} [${severity}] ${msg}`);
      }
    } else {
      console.log(`All ${totalFiles} node(s) passed validation.`);
    }
  }
}

// -- Utilities --

let treeRoot = "";
const textCache = new Map<string, string | null>();

export function setTreeRoot(root: string): void {
  treeRoot = root;
  textCache.clear();
}

export function getTreeRoot(): string {
  return treeRoot;
}

function rel(path: string): string {
  return relative(treeRoot, path);
}

function shouldSkip(path: string): boolean {
  const parts = relative(treeRoot, path).split("/");
  return parts.some((part) => SKIP.has(part) || part.startsWith("."));
}

function readText(path: string): string | null {
  if (!textCache.has(path)) {
    try {
      textCache.set(path, readFileSync(path, "utf-8"));
    } catch {
      textCache.set(path, null);
    }
  }
  return textCache.get(path)!;
}

export function parseFrontmatter(path: string): string | null {
  const text = readText(path);
  if (text === null) return null;
  const m = text.match(FRONTMATTER_RE);
  return m ? m[1] : null;
}

export function parseBody(path: string): string | null {
  const text = readText(path);
  if (text === null) return null;
  const m = text.match(FRONTMATTER_RE);
  if (m) return text.slice(m[0].length);
  return text;
}

export function parseSoftLinks(fm: string): string[] | null {
  // Inline format
  let m = fm.match(SOFT_LINKS_INLINE_RE);
  if (m) {
    const raw = m[1].trim();
    if (!raw) return [];
    return raw
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  // Block format
  m = fm.match(SOFT_LINKS_BLOCK_RE);
  if (m) {
    return m[1]
      .trim()
      .split("\n")
      .map((line) =>
        line
          .trim()
          .replace(/^-\s*/, "")
          .trim()
          .replace(/^['"]|['"]$/g, ""),
      );
  }
  return null;
}

function resolveSoftLink(link: string): boolean {
  const clean = link.replace(/^\/+/, "");
  const target = join(treeRoot, clean);

  // Direct .md file
  try {
    if (statSync(target).isFile() && target.endsWith(".md")) return true;
  } catch {
    // not found
  }
  // Directory with NODE.md
  try {
    if (statSync(target).isDirectory() && existsSync(join(target, "NODE.md")))
      return true;
  } catch {
    // not found
  }
  return false;
}

function normalizeSoftLink(link: string): string {
  const clean = link.replace(/^\/+/, "");
  const target = join(treeRoot, clean);
  try {
    if (statSync(target).isDirectory()) return join(target, "NODE.md");
  } catch {
    // not a directory
  }
  return target;
}

export function collectMdFiles(): string[] {
  const files: string[] = [];
  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (shouldSkip(full)) continue;
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (
          stat.isFile() &&
          entry.endsWith(".md") &&
          !SKIP_FILES.has(entry)
        ) {
          files.push(full);
        }
      } catch {
        // skip
      }
    }
  }
  walk(treeRoot);
  return files;
}

// -- Validation checks --

export function validateOwners(
  fm: string,
  path: string,
  findings: Findings,
): void {
  const m = fm.match(OWNERS_RE);
  if (!m) {
    findings.error(`${rel(path)}: missing 'owners' field in frontmatter`);
    return;
  }
  const raw = m[1].trim();
  if (!raw) return; // owners: [] is valid (inheritance)

  const owners = raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (owners.length === 0) {
    findings.error(`${rel(path)}: owners list contains only whitespace entries`);
    return;
  }
  if (owners.length === 1 && owners[0] === "*") return; // owners: [*] valid

  for (const owner of owners) {
    if (owner === "*") {
      findings.error(
        `${rel(path)}: wildcard '*' must be the sole entry, not mixed with usernames`,
      );
    } else if (!GITHUB_USER_RE.test(owner)) {
      findings.error(`${rel(path)}: invalid owner '${owner}'`);
    }
  }
}

export function validateSoftLinks(
  fm: string,
  path: string,
  findings: Findings,
): void {
  const links = parseSoftLinks(fm);
  if (links === null) return;
  for (const link of links) {
    if (!link) {
      findings.error(`${rel(path)}: empty soft_link entry`);
    } else if (!resolveSoftLink(link)) {
      findings.error(
        `${rel(path)}: soft_link '${link}' does not resolve to an existing node`,
      );
    }
  }
}

export function validateFolders(findings: Findings): void {
  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (shouldSkip(full)) continue;
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!existsSync(join(full, "NODE.md"))) {
        findings.error(`${rel(full)}/: missing NODE.md`);
      }
      walk(full);
    }
  }
  walk(treeRoot);
}

export function validateDirectoryListing(findings: Findings): void {
  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (shouldSkip(full)) continue;
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      const nodeMd = join(full, "NODE.md");
      if (!existsSync(nodeMd)) {
        walk(full);
        continue;
      }
      const body = parseBody(nodeMd);
      if (body !== null) {
        const actualLeaves = new Set<string>();
        for (const f of readdirSync(full).sort()) {
          const fp = join(full, f);
          try {
            if (statSync(fp).isFile() && f.endsWith(".md") && f !== "NODE.md") {
              actualLeaves.add(f);
            }
          } catch {
            // skip
          }
        }
        const referenced = new Set<string>();
        let linkMatch: RegExpExecArray | null;
        const linkRe = /\[.*?\]\(([^)]+\.md)\)/g;
        while ((linkMatch = linkRe.exec(body)) !== null) {
          const ref = linkMatch[1];
          if (ref.startsWith("http") || ref.startsWith("/")) continue;
          if (!ref.includes("/")) referenced.add(ref);
        }
        for (const orphan of [...actualLeaves].filter((f) => !referenced.has(f)).sort()) {
          findings.warning(
            `${rel(nodeMd)}: leaf file '${orphan}' exists but is not mentioned in NODE.md`,
          );
        }
        for (const ref of [...referenced].filter((f) => !actualLeaves.has(f)).sort()) {
          if (!existsSync(join(full, ref))) {
            findings.warning(
              `${rel(nodeMd)}: references '${ref}' but the file does not exist`,
            );
          }
        }
      }
      walk(full);
    }
  }
  walk(treeRoot);
}

export function validateRootDomainSync(findings: Findings): void {
  const nodeMd = join(treeRoot, "NODE.md");
  const body = parseBody(nodeMd);
  if (body === null) return;

  // Strip HTML comments
  const bodyNoComments = body.replace(/<!--.*?-->/gs, "");

  const listedDomains = new Set<string>();
  let dm: RegExpExecArray | null;
  const domainRe = /\[(\w[\w-]*)\/?\]\((\w[\w-]*)\/NODE\.md\)/g;
  while ((dm = domainRe.exec(bodyNoComments)) !== null) {
    listedDomains.add(dm[2]);
  }

  const actualDomains = new Set<string>();
  for (const child of readdirSync(treeRoot).sort()) {
    const full = join(treeRoot, child);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    if (child.startsWith(".") || SKIP.has(child)) continue;
    if (existsSync(join(full, "NODE.md"))) actualDomains.add(child);
  }

  for (const missing of [...actualDomains].filter((d) => !listedDomains.has(d)).sort()) {
    findings.error(
      `NODE.md: domain directory '${missing}/' exists but is not listed in root NODE.md`,
    );
  }
  for (const extra of [...listedDomains].filter((d) => !actualDomains.has(d)).sort()) {
    findings.error(
      `NODE.md: lists domain '${extra}/' but the directory does not exist or has no NODE.md`,
    );
  }
}

export function validateSoftLinkReciprocity(
  files: string[],
  findings: Findings,
): void {
  const allLinks: [string, string][] = [];

  for (const path of files) {
    const fm = parseFrontmatter(path);
    if (fm === null) continue;
    const links = parseSoftLinks(fm);
    if (!links) continue;
    for (const link of links) {
      if (!link) continue;
      const target = normalizeSoftLink(link);
      allLinks.push([path, target]);
    }
  }

  for (const [source, target] of allLinks) {
    if (!existsSync(target)) continue;

    let hasBackLink = false;
    const targetFm = parseFrontmatter(target);
    if (targetFm) {
      const targetLinks = parseSoftLinks(targetFm);
      if (targetLinks) {
        for (const tl of targetLinks) {
          if (!tl) continue;
          const resolved = normalizeSoftLink(tl);
          if (
            resolved === source ||
            resolved === join(source, "..", "NODE.md")
          ) {
            hasBackLink = true;
            break;
          }
        }
      }
    }

    if (!hasBackLink) {
      const targetBody = parseBody(target);
      if (targetBody) {
        const sourceRel = rel(source);
        const linkRe = /\[.*?\]\(([^)]+\.md)\)/g;
        let lm: RegExpExecArray | null;
        while ((lm = linkRe.exec(targetBody)) !== null) {
          const ref = lm[1];
          if (ref.startsWith("http") || ref.startsWith("/")) continue;
          if (sourceRel.endsWith(ref) || ref === sourceRel) {
            hasBackLink = true;
            break;
          }
        }
      }
    }

    if (!hasBackLink) {
      findings.info(
        `${rel(source)}: soft_link to '${rel(target)}' is one-way (target has no reference back)`,
      );
    }
  }
}

export function validateEmptyNodes(
  files: string[],
  findings: Findings,
): void {
  for (const path of files) {
    const text = readText(path);
    if (text === null) continue;
    const m = text.match(FRONTMATTER_RE);
    if (!m) continue;
    const body = text.slice(m[0].length);
    const stripped = body.replace(/\s+/g, "");
    if (stripped.length < MIN_BODY_LENGTH) {
      findings.warning(`${rel(path)}: node has little or no body content`);
    }
  }
}

export function validateTitleMismatch(
  files: string[],
  findings: Findings,
): void {
  for (const path of files) {
    const text = readText(path);
    if (text === null) continue;
    const fmMatch = text.match(FRONTMATTER_RE);
    if (!fmMatch) continue;

    const fm = fmMatch[1];
    const titleMatch = fm.match(TITLE_RE);
    if (!titleMatch) continue;
    const fmTitle = titleMatch[1].trim();

    const body = text.slice(fmMatch[0].length);
    const headingMatch = body.match(/^#\s+(.+)$/m);
    if (!headingMatch) continue;
    const bodyHeading = headingMatch[1].trim();

    if (fmTitle !== bodyHeading) {
      findings.warning(
        `${rel(path)}: frontmatter title '${fmTitle}' differs from first heading '${bodyHeading}'`,
      );
    }
  }
}

export function runValidateNodes(root: string): { exitCode: number; findings: Findings } {
  setTreeRoot(root);
  const files = collectMdFiles();
  const findings = new Findings();

  validateFolders(findings);

  for (const path of files) {
    const fm = parseFrontmatter(path);
    if (fm === null) {
      findings.error(`${rel(path)}: no frontmatter found`);
      continue;
    }
    validateOwners(fm, path, findings);
    validateSoftLinks(fm, path, findings);
  }

  validateDirectoryListing(findings);
  validateRootDomainSync(findings);
  validateSoftLinkReciprocity(files, findings);
  validateEmptyNodes(files, findings);
  validateTitleMismatch(files, findings);

  findings.printReport(files.length);
  return { exitCode: findings.hasErrors() ? 1 : 0, findings };
}
