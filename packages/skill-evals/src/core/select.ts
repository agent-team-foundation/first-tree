import { execFileSync } from "node:child_process";

import { type ShippedSkillName, UNEVALUATED_SHIPPED_SKILLS } from "./case-schema.js";

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
    paths: ["skills/context-tree-audit/", "packages/skill-evals/src/suites/context-tree-audit/"],
    skill: "context-tree-audit",
  },
  {
    paths: [
      "skills/context-tree-review/",
      "packages/skill-evals/src/suites/context-tree-review/",
      "packages/server/src/prompts/context-reviewer-pr.ejs",
    ],
    skill: "context-tree-review",
  },
  {
    paths: ["skills/first-tree-qa/", "packages/qa/", "packages/skill-evals/src/suites/first-tree-qa/"],
    skill: "first-tree-qa",
  },
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

function addFloorRecommendation(
  recommendations: Map<string, EvalRecommendation>,
  skill: ShippedSkillName | null,
  reason: string,
): void {
  addRecommendation(recommendations, {
    command: floorCommand(skill),
    kind: "floor",
    reason,
    suite: skill ?? "all",
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

// A shipped skill that is intentionally outside the eval harness
// (`UNEVALUATED_SHIPPED_SKILLS`). Returns the skill name so the selector can
// emit an explicit "no eval by design" note instead of silently recommending
// nothing, which would read the same as "forgot to wire up a suite".
function intentionallyUnevaluatedSkill(path: string): string | null {
  for (const skill of UNEVALUATED_SHIPPED_SKILLS) {
    if (path.startsWith(`skills/${skill}/`)) return skill;
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

function isAgentBriefingRuntimePath(path: string): boolean {
  return (
    path === "packages/client/src/runtime/agent-briefing.ts" ||
    path === "packages/client/src/runtime/templates/agent-briefing.ejs"
  );
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
    const unevaluatedSkill = intentionallyUnevaluatedSkill(path);
    if (unevaluatedSkill !== null) {
      notes.push(
        `${path} belongs to ${unevaluatedSkill}, a shipped skill intentionally outside skill-evals (see UNEVALUATED_SHIPPED_SKILLS); no eval selected.`,
      );
      continue;
    }

    if (isAgentBriefingRuntimePath(path)) {
      addFloorRecommendation(recommendations, null, `${path} changes generated briefing text`);
      continue;
    }

    const periodicSkill = periodicFrameworkSkill(path);
    if (periodicSkill !== null) {
      addFloorRecommendation(
        recommendations,
        periodicSkill === "all" ? null : periodicSkill,
        `${path} touches periodic eval framework`,
      );
      continue;
    }

    const skill = matchingSkill(path);
    if (skill !== null) {
      addFloorRecommendation(recommendations, skill, `${path} touches ${skill}`);
      continue;
    }

    if (path.startsWith("packages/skill-evals/src/core/provider/")) {
      addFloorRecommendation(recommendations, null, `${path} touches tested-agent provider infrastructure`);
      continue;
    }

    if (isSkillEvalCorePath(path) || isSkillEvalCliOrSchemaPath(path)) {
      addFloorRecommendation(recommendations, null, `${path} touches shared skill-eval infrastructure`);
      continue;
    }

    if (path.startsWith("packages/skill-evals/src/suites/quality/")) {
      addFloorRecommendation(recommendations, null, `${path} touches shared quality runner`);
      continue;
    }

    if (isSkillEvalDocsOnly(path)) {
      addFloorRecommendation(recommendations, null, `${path} is skill-eval documentation or usage text`);
    }
  }

  if (changedFiles.length === 0) {
    notes.push("No changed files were provided; no skill eval runs selected.");
  }
  if (recommendations.size > 0) {
    notes.push(
      "Model-backed gate, quality, and periodic evals are never selected automatically; run them only on explicit human instruction.",
    );
  }
  if (recommendations.size === 0 && changedFiles.length > 0 && notes.length === 0) {
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
