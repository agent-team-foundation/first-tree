import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_NAMES = [
  "first-tree",
  "first-tree-onboarding",
  "first-tree-sync",
  "first-tree-write",
  "first-tree-github-scan",
  "github-scan",
] as const;

export type SkillName = (typeof SKILL_NAMES)[number];

type SkillLayout = {
  name: SkillName;
  agentsPath: string;
  claudePath: string;
  claudeSymlinkTarget: string;
};

export type SkillEntryKind = "missing" | "symlink" | "directory";

export type SkillStatus = {
  cliCompat: string | null;
  cliVersion: string | null;
  // `true` when the skill's `cliCompat` range satisfies `cliVersion`,
  // `false` when it does not, `null` when either piece is missing or the
  // range is unparseable. `null` is also returned for skills that are not
  // installed at all (no SKILL.md to read `cliCompat` from).
  compatible: boolean | null;
  name: SkillName;
  installed: boolean;
  version: string | null;
  agentsKind: SkillEntryKind;
  agentsTarget: string | null;
  claudeKind: SkillEntryKind;
  claudeTarget: string | null;
};

export type SkillDiagnosis = {
  cliVersion: string | null;
  // When non-null, the skill's `cliCompat` range was parsed and rejected the
  // current CLI version. Carries the original range string so renderers can
  // give an actionable upgrade-CLI/pin-skill suggestion instead of the
  // generic "skill link / skill upgrade" hint.
  incompatibleCliCompat: string | null;
  name: SkillName;
  ok: boolean;
  problems: string[];
};

const FRONTMATTER_RE = /^---\s*\n(.*?)\n---/su;

export type ManagedFileAction = "created" | "updated" | "unchanged" | "skipped";

const FIRST_TREE_REFERENCE_FILES = [
  "SKILL.md",
  "VERSION",
  join("agents", "openai.yaml"),
  join("references", "structure.md"),
  join("references", "functions.md"),
  join("references", "anti-patterns.md"),
  join("references", "maintenance.md"),
  join("references", "cli-manual.md"),
  join("references", "llms.txt"),
] as const;

const STANDARD_SKILL_REQUIRED_FILES = [
  "SKILL.md",
  "VERSION",
  join("agents", "openai.yaml"),
] as const;

const WHITEPAPER_FILE = "WHITEPAPER.md";
const WHITEPAPER_SYMLINK_TARGET = join(".agents", "skills", "first-tree", "SKILL.md");

function layoutForSkill(name: SkillName): SkillLayout {
  return {
    name,
    agentsPath: join(".agents", "skills", name),
    claudePath: join(".claude", "skills", name),
    claudeSymlinkTarget: join("..", "..", ".agents", "skills", name),
  };
}

function allSkillLayouts(): readonly SkillLayout[] {
  return SKILL_NAMES.map(layoutForSkill);
}

function requiredFilesForSkill(name: SkillName): readonly string[] {
  return name === "first-tree" ? FIRST_TREE_REFERENCE_FILES : STANDARD_SKILL_REQUIRED_FILES;
}

export function bundledSkillsRootFrom(startDir: string): string {
  let currentDir = resolve(startDir);

  while (true) {
    const candidate = join(currentDir, "skills", "first-tree", "SKILL.md");

    if (existsSync(candidate)) {
      return join(currentDir, "skills");
    }

    const parentDir = dirname(currentDir);

    if (parentDir === currentDir) {
      throw new Error(
        "Could not locate bundled `skills/` payloads. Run from a source checkout or a packaged dist that includes `skills/`.",
      );
    }

    currentDir = parentDir;
  }
}

export function resolveBundledSkillsRoot(): string {
  return bundledSkillsRootFrom(dirname(fileURLToPath(import.meta.url)));
}

export function inspectSkillEntry(path: string): {
  kind: SkillEntryKind;
  target: string | null;
} {
  try {
    const stat = lstatSync(path);

    if (stat.isSymbolicLink()) {
      return {
        kind: "symlink",
        target: readlinkSync(path),
      };
    }

    if (stat.isDirectory()) {
      return {
        kind: "directory",
        target: null,
      };
    }
  } catch {
    // Fall through to missing.
  }

  return {
    kind: "missing",
    target: null,
  };
}

function readVersion(path: string): string | null {
  const versionPath = join(path, "VERSION");

  if (!existsSync(versionPath)) {
    return null;
  }

  try {
    return readFileSync(versionPath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function readBundledSkillVersion(): string {
  const version = readVersion(join(resolveBundledSkillsRoot(), "first-tree"));
  if (version === null) {
    throw new Error("Could not read the bundled first-tree skill version.");
  }
  return version;
}

function readSkillFrontmatterMetadata(path: string): {
  cliCompat: string | null;
  frontmatterVersion: string | null;
} {
  const skillPath = join(path, "SKILL.md");

  if (!existsSync(skillPath)) {
    return {
      cliCompat: null,
      frontmatterVersion: null,
    };
  }

  try {
    const text = readFileSync(skillPath, "utf8");
    const match = text.match(FRONTMATTER_RE);
    if (!match?.[1]) {
      return {
        cliCompat: null,
        frontmatterVersion: null,
      };
    }

    const frontmatter = match[1];
    const versionMatch = frontmatter.match(/^version:\s*["']?(.+?)["']?\s*$/mu);
    const cliCompatMatch = frontmatter.match(
      /^cliCompat:\s*\n\s*first-tree:\s*["']?(.+?)["']?\s*$/mu,
    );

    return {
      cliCompat: cliCompatMatch?.[1] ?? null,
      frontmatterVersion: versionMatch?.[1] ?? null,
    };
  } catch {
    return {
      cliCompat: null,
      frontmatterVersion: null,
    };
  }
}

function readCliVersionFrom(startDir: string): string | null {
  let currentDir = resolve(startDir);

  while (true) {
    const candidate = join(currentDir, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
        return typeof parsed.version === "string" ? parsed.version : null;
      } catch {
        return null;
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function parseSemverCore(version: string): [number, number, number] | null {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/u);
  if (!match) {
    return null;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(left: string, right: string): number | null {
  const leftParts = parseSemverCore(left);
  const rightParts = parseSemverCore(right);

  if (leftParts === null || rightParts === null) {
    return null;
  }

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }

  return 0;
}

function satisfiesComparator(version: string, comparator: string): boolean | null {
  const match = comparator.trim().match(/^(>=|>|<=|<|=)\s*(.+)$/u);
  if (!match) {
    return null;
  }

  const comparison = compareSemver(version, match[2]);
  if (comparison === null) {
    return null;
  }

  switch (match[1]) {
    case ">=":
      return comparison >= 0;
    case ">":
      return comparison > 0;
    case "<=":
      return comparison <= 0;
    case "<":
      return comparison < 0;
    case "=":
      return comparison === 0;
    default:
      return null;
  }
}

function isCliCompatible(cliVersion: string | null, cliCompat: string | null): boolean | null {
  if (cliVersion === null || cliCompat === null) {
    return null;
  }

  const comparators = cliCompat
    .split(/\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);

  if (comparators.length === 0) {
    return null;
  }

  for (const comparator of comparators) {
    const satisfied = satisfiesComparator(cliVersion, comparator);
    if (satisfied === null) {
      return null;
    }
    if (!satisfied) {
      return false;
    }
  }

  return true;
}

function ensureClaudeSymlink(targetRoot: string, layout: SkillLayout): void {
  const claudeFull = join(targetRoot, layout.claudePath);
  mkdirSync(dirname(claudeFull), { recursive: true });

  const existing = inspectSkillEntry(claudeFull);
  if (existing.kind !== "missing") {
    if (existing.kind === "symlink" && existing.target === layout.claudeSymlinkTarget) {
      return;
    }

    rmSync(claudeFull, { force: true, recursive: true });
  }

  symlinkSync(layout.claudeSymlinkTarget, claudeFull);
}

export function copyCanonicalSkills(targetRoot: string): void {
  const bundledSkillsRoot = resolveBundledSkillsRoot();

  for (const layout of allSkillLayouts()) {
    const sourceDir = join(bundledSkillsRoot, layout.name);
    const agentsFull = join(targetRoot, layout.agentsPath);
    mkdirSync(dirname(agentsFull), { recursive: true });
    rmSync(agentsFull, { force: true, recursive: true });
    cpSync(sourceDir, agentsFull, { recursive: true });
    ensureClaudeSymlink(targetRoot, layout);
  }
}

export function collectSkillStatus(targetRoot: string): readonly SkillStatus[] {
  const cliVersion = readCliVersionFrom(dirname(fileURLToPath(import.meta.url)));

  return allSkillLayouts().map((layout) => {
    const agentsFull = join(targetRoot, layout.agentsPath);
    const claudeFull = join(targetRoot, layout.claudePath);
    const agents = inspectSkillEntry(agentsFull);
    const claude = inspectSkillEntry(claudeFull);
    const installed = agents.kind !== "missing" && claude.kind !== "missing";
    const metadata =
      agents.kind === "missing"
        ? { cliCompat: null, frontmatterVersion: null }
        : readSkillFrontmatterMetadata(agentsFull);

    return {
      cliCompat: metadata.cliCompat,
      cliVersion,
      compatible:
        agents.kind === "missing" ? null : isCliCompatible(cliVersion, metadata.cliCompat),
      name: layout.name,
      installed,
      version: agents.kind === "missing" ? null : readVersion(agentsFull),
      agentsKind: agents.kind,
      agentsTarget: agents.target,
      claudeKind: claude.kind,
      claudeTarget: claude.target,
    };
  });
}

export function collectSkillDiagnosis(targetRoot: string): readonly SkillDiagnosis[] {
  const cliVersion = readCliVersionFrom(dirname(fileURLToPath(import.meta.url)));

  return allSkillLayouts().map((layout) => {
    const problems: string[] = [];
    let incompatibleCliCompat: string | null = null;
    const agentsFull = join(targetRoot, layout.agentsPath);
    const claudeFull = join(targetRoot, layout.claudePath);
    const agents = inspectSkillEntry(agentsFull);
    const claude = inspectSkillEntry(claudeFull);
    const metadata =
      agents.kind === "missing"
        ? { cliCompat: null, frontmatterVersion: null }
        : readSkillFrontmatterMetadata(agentsFull);

    if (agents.kind === "missing") {
      problems.push(`missing: ${layout.agentsPath}`);
    } else {
      for (const requiredFile of requiredFilesForSkill(layout.name)) {
        if (!existsSync(join(agentsFull, requiredFile))) {
          problems.push(`${layout.agentsPath}/${requiredFile} does not exist`);
        }
      }

      const version = readVersion(agentsFull);
      if (metadata.frontmatterVersion === null) {
        problems.push(`${layout.agentsPath}/SKILL.md frontmatter is missing version`);
      } else if (version !== null && metadata.frontmatterVersion !== version) {
        problems.push(
          `${layout.agentsPath}/SKILL.md version ${metadata.frontmatterVersion} does not match VERSION ${version}`,
        );
      }

      if (metadata.cliCompat === null) {
        problems.push(`${layout.agentsPath}/SKILL.md frontmatter is missing cliCompat.first-tree`);
      } else {
        const compatible = isCliCompatible(cliVersion, metadata.cliCompat);
        if (compatible === false) {
          incompatibleCliCompat = metadata.cliCompat;
          problems.push(
            `${layout.name} requires first-tree ${metadata.cliCompat}, but the current CLI version is ${cliVersion ?? "unknown"}`,
          );
        } else if (compatible === null) {
          problems.push(`${layout.name} has an unreadable cliCompat range: ${metadata.cliCompat}`);
        }
      }
    }

    if (claude.kind === "missing") {
      problems.push(`missing: ${layout.claudePath}`);
    } else if (claude.kind !== "symlink") {
      problems.push(`${layout.claudePath} should be a symlink to ${layout.claudeSymlinkTarget}`);
    } else if (claude.target !== layout.claudeSymlinkTarget) {
      problems.push(
        `${layout.claudePath} -> ${claude.target}, expected ${layout.claudeSymlinkTarget}`,
      );
    }

    return {
      cliVersion,
      incompatibleCliCompat,
      name: layout.name,
      ok: problems.length === 0,
      problems,
    };
  });
}

export function repairClaudeSkillLinks(targetRoot: string): {
  linked: number;
  skipped: number;
  messages: string[];
} {
  let linked = 0;
  let skipped = 0;
  const messages: string[] = [];

  for (const layout of allSkillLayouts()) {
    const agentsFull = join(targetRoot, layout.agentsPath);

    if (!existsSync(agentsFull)) {
      skipped += 1;
      continue;
    }

    const claudeFull = join(targetRoot, layout.claudePath);
    const before = inspectSkillEntry(claudeFull);
    ensureClaudeSymlink(targetRoot, layout);
    const after = inspectSkillEntry(claudeFull);

    if (before.kind !== "symlink" || before.target !== after.target) {
      linked += 1;
      messages.push(`linked ${layout.claudePath} -> ${layout.claudeSymlinkTarget}`);
    }
  }

  return {
    linked,
    skipped,
    messages,
  };
}

export function upsertWhitepaperFile(targetRoot: string): ManagedFileAction {
  const fullPath = join(targetRoot, WHITEPAPER_FILE);
  const existing = inspectSkillEntry(fullPath);

  if (existing.kind === "symlink" && existing.target === WHITEPAPER_SYMLINK_TARGET) {
    return "unchanged";
  }

  if (existing.kind === "directory") {
    return "skipped";
  }

  if (existing.kind === "symlink") {
    rmSync(fullPath, { force: true });
    symlinkSync(WHITEPAPER_SYMLINK_TARGET, fullPath);
    return "updated";
  }

  if (existsSync(fullPath)) {
    return "skipped";
  }

  symlinkSync(WHITEPAPER_SYMLINK_TARGET, fullPath);
  return "created";
}
