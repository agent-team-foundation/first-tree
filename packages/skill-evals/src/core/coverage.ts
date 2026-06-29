import {
  SHIPPED_SKILLS,
  type ShippedSkillName,
  type SkillEvalCase,
  type SkillEvalTier,
  type ValidationResult,
  validateCaseCollection,
} from "./case-schema.js";

export type CoverageStatus = "implemented" | "planned";

export type CoverageTierEntry = {
  caseIds: readonly string[];
  description: string;
  status: CoverageStatus;
  tier: SkillEvalTier;
};

export type SkillCoverageEntry = {
  skill: ShippedSkillName;
  tiers: readonly CoverageTierEntry[];
};

export type SkillEvalSuiteDefinition = {
  cases: readonly SkillEvalCase[];
  coverage: SkillCoverageEntry;
  skill: ShippedSkillName;
  validateFloor?: (cases: readonly SkillEvalCase[]) => readonly string[];
};

function entryForTier(entry: SkillCoverageEntry, tier: SkillEvalTier): CoverageTierEntry | null {
  return entry.tiers.find((candidate) => candidate.tier === tier) ?? null;
}

export function validateCoverageMatrix(suites: readonly SkillEvalSuiteDefinition[]): ValidationResult {
  const errors: string[] = [];
  const seenSkills = new Set<string>();

  for (const suite of suites) {
    if (suite.skill !== suite.coverage.skill) {
      errors.push(`${suite.skill}: suite skill does not match coverage skill ${suite.coverage.skill}.`);
    }
    if (seenSkills.has(suite.skill)) {
      errors.push(`${suite.skill}: duplicate suite coverage entry.`);
    }
    seenSkills.add(suite.skill);

    const floor = entryForTier(suite.coverage, "floor");
    const gate = entryForTier(suite.coverage, "gate");
    if (floor === null) {
      errors.push(`${suite.skill}: missing floor coverage entry.`);
    } else if (floor.caseIds.length === 0) {
      errors.push(`${suite.skill}: floor coverage entry must list at least one case.`);
    }
    if (gate === null) {
      errors.push(`${suite.skill}: missing gate coverage entry.`);
    } else if (gate.caseIds.length === 0) {
      errors.push(`${suite.skill}: gate coverage entry must list at least one case.`);
    }

    const validation = validateCaseCollection(suite.cases);
    for (const error of validation.errors) {
      errors.push(`${suite.skill}: ${error}`);
    }

    const suiteCaseIds = new Set(suite.cases.map((evalCase) => evalCase.id));
    const suiteCasesById = new Map(suite.cases.map((evalCase) => [evalCase.id, evalCase]));
    for (const tierEntry of suite.coverage.tiers) {
      for (const caseId of tierEntry.caseIds) {
        if (!suiteCaseIds.has(caseId)) {
          errors.push(`${suite.skill}: coverage references unknown case ${caseId}.`);
          continue;
        }

        const evalCase = suiteCasesById.get(caseId);
        if (evalCase?.skill !== suite.skill) {
          errors.push(`${suite.skill}: coverage references case ${caseId} with skill ${evalCase?.skill}.`);
        }
        if (evalCase?.tier !== tierEntry.tier) {
          errors.push(`${suite.skill}: ${tierEntry.tier} coverage references ${evalCase?.tier} case ${caseId}.`);
        }
      }
    }

    const floorValidationErrors = suite.validateFloor?.(suite.cases) ?? [];
    for (const error of floorValidationErrors) {
      errors.push(`${suite.skill}: ${error}`);
    }
  }

  for (const skill of SHIPPED_SKILLS) {
    if (!seenSkills.has(skill)) {
      errors.push(`${skill}: missing suite coverage entry.`);
    }
  }

  return { errors, ok: errors.length === 0 };
}
