export const SHIPPED_SKILLS = ["first-tree-read", "first-tree-write", "first-tree-seed", "first-tree-welcome"] as const;

// Skills that ship in the runtime but are intentionally NOT modeled by this
// eval harness. skill-evals is built around per-suite, model-graded live runners
// for the Context-Tree / onboarding skill family (each suite carries a bespoke
// fixture + grader + gate runner). `first-tree-file-bug` and `first-tree-gitlab`
// both perform external provider writes: the former creates a public GitHub issue
// after human confirmation, while the latter can create GitLab entities and change
// notification subscriptions. Those side-effecting, credential-dependent flows
// belong in isolated QA rather than this live model harness. Their guardrails
// (core-tier install, trigger boundary, family-map wiring, and generated-briefing
// routing) are covered by client unit / drift tests. They are named here so their
// omission from `SHIPPED_SKILLS` is explicit; revisit when either skill gains a
// deterministic, model-gradable surface.
export const UNEVALUATED_SHIPPED_SKILLS = ["first-tree-file-bug", "first-tree-gitlab"] as const;

export const SKILL_EVAL_TIERS = ["floor", "gate", "quality", "periodic"] as const;
export const EVAL_CASE_STATUSES = ["implemented", "planned"] as const;
export const BRIEFING_MODES = ["minimal", "generated-fixture", "runtime-generated"] as const;
export const PROVIDER_NAMES = ["codex", "claude"] as const;

export type ShippedSkillName = (typeof SHIPPED_SKILLS)[number];
export type SkillEvalTier = (typeof SKILL_EVAL_TIERS)[number];
export type EvalCaseStatus = (typeof EVAL_CASE_STATUSES)[number];
export type BriefingMode = (typeof BRIEFING_MODES)[number];
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export type SkillEvalCase<Fixture = unknown, Expected = unknown> = {
  briefingMode: BriefingMode;
  expected: Expected;
  fixture: Fixture;
  forbidden?: unknown;
  id: string;
  prompt?: string;
  provider?: ProviderName;
  skill: ShippedSkillName;
  status: EvalCaseStatus;
  tags?: readonly string[];
  tier: SkillEvalTier;
};

export type ValidationResult = {
  errors: readonly string[];
  ok: boolean;
};

type StringSet = readonly string[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends StringSet>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && allowed.includes(value);
}

function validateOptionalStringArray(value: unknown, field: string, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array when present.`);
    return;
  }
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      errors.push(`${field} must contain only non-empty strings.`);
      return;
    }
  }
}

export function validateSkillEvalCase(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { errors: ["case must be an object."], ok: false };
  }

  if (typeof value.id !== "string" || value.id.trim() === "") {
    errors.push("id must be a non-empty string.");
  }
  if (!isOneOf(value.skill, SHIPPED_SKILLS)) {
    errors.push(`skill must be one of: ${SHIPPED_SKILLS.join(", ")}.`);
  }
  if (!isOneOf(value.tier, SKILL_EVAL_TIERS)) {
    errors.push(`tier must be one of: ${SKILL_EVAL_TIERS.join(", ")}.`);
  }
  if (!isOneOf(value.status, EVAL_CASE_STATUSES)) {
    errors.push(`status must be one of: ${EVAL_CASE_STATUSES.join(", ")}.`);
  }
  if (!isOneOf(value.briefingMode, BRIEFING_MODES)) {
    errors.push(`briefingMode must be one of: ${BRIEFING_MODES.join(", ")}.`);
  }
  if (value.provider !== undefined && !isOneOf(value.provider, PROVIDER_NAMES)) {
    errors.push(`provider must be one of: ${PROVIDER_NAMES.join(", ")} when present.`);
  }
  if (value.prompt !== undefined && (typeof value.prompt !== "string" || value.prompt.trim() === "")) {
    errors.push("prompt must be a non-empty string when present.");
  }
  if ((value.tier === "gate" || value.tier === "quality" || value.tier === "periodic") && value.prompt === undefined) {
    errors.push(`${String(value.tier)} cases must include prompt.`);
  }
  if (!isRecord(value.fixture)) {
    errors.push("fixture must be an object.");
  }
  if (!isRecord(value.expected)) {
    errors.push("expected must be an object.");
  }
  validateOptionalStringArray(value.tags, "tags", errors);

  return { errors, ok: errors.length === 0 };
}

export function validateCaseCollection(cases: readonly SkillEvalCase[]): ValidationResult {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const evalCase of cases) {
    const caseValidation = validateSkillEvalCase(evalCase);
    for (const error of caseValidation.errors) {
      errors.push(`${evalCase.id || "<missing-id>"}: ${error}`);
    }

    if (seen.has(evalCase.id)) {
      errors.push(`${evalCase.id}: duplicate case id.`);
    }
    seen.add(evalCase.id);
  }

  return { errors, ok: errors.length === 0 };
}
