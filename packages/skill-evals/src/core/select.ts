import { execFileSync } from "node:child_process";

import type { ShippedSkillName } from "./case-schema.js";

export type EvalRecommendationKind = "floor" | "gate" | "periodic" | "quality";

export type EvalRecommendation = {
  command: string;
  kind: EvalRecommendationKind;
  reason: string;
  suite: ShippedSkillName | "all" | null;
};

export type EvalSelectionSummary = {
  base: string | null;
  changedFiles: readonly string[];
  notes: readonly string[];
  recommendations: readonly EvalRecommendation[];
};

const SKILL_BY_PATH: readonly {
  skill: ShippedSkillName;
  paths: readonly string[];
}[] = [
  {
    paths: ["skills/first-tree-read/", "packages/skill-evals/src/suites/first-tree-read/"],
    skill: "first-tree-read",
  },
  {
    paths: ["skills/first-tree-write/", "packages/skill-evals/src/suites/first-tree-write/"],
    skill: "first-tree-write",
  },
  {
    paths: ["skills/first-tree-seed/", "packages/skill-evals/src/suites/first-tree-seed/"],
    skill: "first-tree-seed",
  },
  {
    paths: ["skills/first-tree-welcome/", "packages/skill-evals/src/suites/first-tree-welcome/"],
    skill: "first-tree-welcome",
  },
];

function normalizePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function addRecommendation(recommendations: Map<string, EvalRecommendation>, recommendation: EvalRecommendation): void {
  if (!recommendations.has(recommendation.command)) {
    recommendations.set(recommendation.command, recommendation);
  }
}

function floorCommand(skill: ShippedSkillName | null): string {
  if (skill === null) return "pnpm --filter @first-tree/skill-evals eval:floor";
  return `pnpm --filter @first-tree/skill-evals eval:floor -- --suite ${skill}`;
}

function gateCommand(skill: ShippedSkillName): string {
  return `pnpm --filter @first-tree/skill-evals eval:gate -- --suite ${skill}`;
}

function qualityCommand(
  skill: Extract<ShippedSkillName, "first-tree-write" | "first-tree-seed" | "first-tree-welcome">,
): string {
  return `pnpm --filter @first-tree/skill-evals eval:quality -- --suite ${skill}`;
}

function periodicCommand(skill: ShippedSkillName | null = null): string {
  if (skill === null) return "pnpm --filter @first-tree/skill-evals eval:periodic";
  return `pnpm --filter @first-tree/skill-evals eval:periodic -- --suite ${skill}`;
}

function addSuiteRecommendations(
  recommendations: Map<string, EvalRecommendation>,
  skill: ShippedSkillName,
  reason: string,
): void {
  addRecommendation(recommendations, {
    command: floorCommand(skill),
    kind: "floor",
    reason,
    suite: skill,
  });

  addRecommendation(recommendations, {
    command: gateCommand(skill),
    kind: "gate",
    reason,
    suite: skill,
  });

  if (skill === "first-tree-write" || skill === "first-tree-seed" || skill === "first-tree-welcome") {
    addRecommendation(recommendations, {
      command: qualityCommand(skill),
      kind: "quality",
      reason,
      suite: skill,
    });
  }
}

function addAllImplementedGateRecommendations(recommendations: Map<string, EvalRecommendation>, reason: string): void {
  addRecommendation(recommendations, {
    command: floorCommand(null),
    kind: "floor",
    reason,
    suite: "all",
  });
  for (const skill of ["first-tree-read", "first-tree-write", "first-tree-seed", "first-tree-welcome"] as const) {
    addRecommendation(recommendations, {
      command: gateCommand(skill),
      kind: "gate",
      reason,
      suite: skill,
    });
  }
}

function addQualityRecommendations(recommendations: Map<string, EvalRecommendation>, reason: string): void {
  for (const skill of ["first-tree-write", "first-tree-seed", "first-tree-welcome"] as const) {
    addRecommendation(recommendations, {
      command: qualityCommand(skill),
      kind: "quality",
      reason,
      suite: skill,
    });
  }
}

function addProviderRecommendations(recommendations: Map<string, EvalRecommendation>, reason: string): void {
  addAllImplementedGateRecommendations(recommendations, reason);
  addRecommendation(recommendations, {
    command: periodicCommand("first-tree-read"),
    kind: "periodic",
    reason,
    suite: "first-tree-read",
  });
}

function matchingSkill(path: string): ShippedSkillName | null {
  for (const entry of SKILL_BY_PATH) {
    if (entry.paths.some((prefix) => path.startsWith(prefix))) {
      return entry.skill;
    }
  }
  return null;
}

function isSkillEvalCorePath(path: string): boolean {
  return path.startsWith("packages/skill-evals/src/core/") || path === "packages/skill-evals/src/index.ts";
}

function periodicFrameworkSkill(path: string): ShippedSkillName | "all" | null {
  if (
    path === "packages/skill-evals/src/core/periodic.ts" ||
    path.startsWith("packages/skill-evals/src/core/periodic/") ||
    path.startsWith("packages/skill-evals/src/suites/periodic/")
  ) {
    return "all";
  }
  for (const skill of ["first-tree-read", "first-tree-write", "first-tree-seed", "first-tree-welcome"] as const) {
    if (path === `packages/skill-evals/src/suites/${skill}/periodic.ts`) return skill;
    if (path.startsWith(`packages/skill-evals/src/suites/${skill}/periodic/`)) return skill;
  }
  return null;
}

function isSkillEvalCliOrSchemaPath(path: string): boolean {
  return (
    path === "packages/skill-evals/package.json" ||
    path === "packages/skill-evals/src/suites/registry.ts" ||
    path === "packages/skill-evals/src/suites/types.ts"
  );
}

function isSkillEvalDocsOnly(path: string): boolean {
  return path === "packages/skill-evals/README.md" || path.startsWith("packages/skill-evals/docs/");
}

export function selectSkillEvalRecommendations(
  changedFilesInput: readonly string[],
  base: string | null = null,
): EvalSelectionSummary {
  const changedFiles = [
    ...new Set(changedFilesInput.map(normalizePath).filter((path) => path.trim().length > 0)),
  ].sort();
  const recommendations = new Map<string, EvalRecommendation>();
  const notes: string[] = [];

  for (const path of changedFiles) {
    const periodicSkill = periodicFrameworkSkill(path);
    if (periodicSkill !== null) {
      addRecommendation(recommendations, {
        command: periodicCommand(periodicSkill === "all" ? null : periodicSkill),
        kind: "periodic",
        reason: `${path} touches periodic eval framework`,
        suite: periodicSkill,
      });
      continue;
    }

    const skill = matchingSkill(path);
    if (skill !== null) {
      addSuiteRecommendations(recommendations, skill, `${path} touches ${skill}`);
      continue;
    }

    if (path.startsWith("packages/skill-evals/src/core/provider/")) {
      addProviderRecommendations(recommendations, `${path} touches tested-agent provider infrastructure`);
      continue;
    }

    if (isSkillEvalCorePath(path) || isSkillEvalCliOrSchemaPath(path)) {
      addAllImplementedGateRecommendations(recommendations, `${path} touches shared skill-eval infrastructure`);
      if (path.startsWith("packages/skill-evals/src/core/judge/")) {
        addQualityRecommendations(recommendations, `${path} touches judge infrastructure`);
      }
      continue;
    }

    if (path.startsWith("packages/skill-evals/src/suites/quality/")) {
      addRecommendation(recommendations, {
        command: floorCommand(null),
        kind: "floor",
        reason: `${path} touches shared quality runner`,
        suite: "all",
      });
      addQualityRecommendations(recommendations, `${path} touches shared quality runner`);
      continue;
    }

    if (isSkillEvalDocsOnly(path)) {
      addRecommendation(recommendations, {
        command: floorCommand(null),
        kind: "floor",
        reason: `${path} is skill-eval documentation or usage text`,
        suite: "all",
      });
    }
  }

  if (changedFiles.length === 0) {
    notes.push("No changed files were provided; no skill eval runs selected.");
  }
  if (recommendations.size === 0 && changedFiles.length > 0) {
    notes.push("No skill-eval-related changes were detected.");
  }

  return {
    base,
    changedFiles,
    notes,
    recommendations: [...recommendations.values()],
  };
}

function gitRefExists(repoRoot: string, ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function resolveDiffBase(repoRoot: string, base: string): string {
  if (base.includes("/") || base.includes("...")) return base;
  const originBase = `origin/${base}`;
  return gitRefExists(repoRoot, originBase) ? originBase : base;
}

export function changedFilesFromGit(repoRoot: string, base: string): readonly string[] {
  const diffBase = resolveDiffBase(repoRoot, base);
  const outputs = [
    execFileSync("git", ["diff", "--name-only", `${diffBase}...HEAD`], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
    execFileSync("git", ["diff", "--name-only"], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
    execFileSync("git", ["diff", "--name-only", "--cached"], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
    execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
  ];
  return [
    ...new Set(
      outputs
        .join("\n")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ].sort();
}

export function formatSelectionSummary(summary: EvalSelectionSummary): string {
  const lines = ["Skill Eval Selection", ""];
  lines.push(`Base: ${summary.base ?? "explicit file list"}`);
  lines.push(`Changed files: ${summary.changedFiles.length}`);
  for (const path of summary.changedFiles) {
    lines.push(`- ${path}`);
  }
  if (summary.recommendations.length > 0) {
    lines.push("", "Recommended commands:");
    for (const recommendation of summary.recommendations) {
      lines.push(`- ${recommendation.command}`);
      lines.push(`  reason: ${recommendation.reason}`);
    }
  }
  if (summary.notes.length > 0) {
    lines.push("", "Notes:");
    for (const note of summary.notes) {
      lines.push(`- ${note}`);
    }
  }
  return lines.join("\n");
}
