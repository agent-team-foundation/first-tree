import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  FIRST_TREE_SEED_QUALITY_DEFINITION,
  FIRST_TREE_SEED_QUALITY_SANITY_FIXTURES,
} from "../../suites/first-tree-seed/quality.js";
import {
  FIRST_TREE_WELCOME_QUALITY_DEFINITION,
  FIRST_TREE_WELCOME_QUALITY_SANITY_FIXTURES,
} from "../../suites/first-tree-welcome/quality.js";
import {
  FIRST_TREE_WRITE_QUALITY_DEFINITION,
  FIRST_TREE_WRITE_QUALITY_SANITY_FIXTURES,
} from "../../suites/first-tree-write/quality.js";
import { runQualityEval } from "../../suites/quality/runner.js";
import type { QualityArtifactInput } from "../../suites/quality/types.js";
import { codexJudgeArgs, codexJudgeEnv } from "../judge/codex.js";
import { createFakeJudgeProvider } from "../judge/fake.js";
import { evaluateJudgeOutput, parseJudgeJson } from "../judge/schema.js";
import type { JudgeRubricDimension } from "../judge/types.js";
import { createRunPaths } from "../paths.js";

const DIMENSIONS: readonly JudgeRubricDimension[] = [
  {
    description: "A",
    key: "axis_a",
    threshold: 4,
  },
  {
    description: "B",
    key: "axis_b",
    threshold: 3,
  },
];

function tempPackageRoot(): string {
  return mkdtempSync(join(tmpdir(), "skill-evals-quality-test-"));
}

function repoPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function fakeArtifactInput(): ReadonlyMap<string, QualityArtifactInput> {
  return new Map([
    [
      "first-tree-write-node-quality",
      {
        artifact: "Actual tree diff from a fake deterministic gate.",
        deterministicGatePassed: true,
        gateCaseId: "durable-source-writes",
        gateRunRoot: "/tmp/fake-gate",
        gateSummaryJsonPath: "/tmp/fake-gate/summary.json",
        gateSummaryMdPath: "/tmp/fake-gate/summary.md",
        source: "Durable source artifact from a fake deterministic gate.",
      },
    ],
  ]);
}

function failedGateArtifactInput(): ReadonlyMap<string, QualityArtifactInput> {
  return new Map([
    [
      "first-tree-write-node-quality",
      {
        artifact: "No reliable tree diff because deterministic gate failed.",
        deterministicGatePassed: false,
        gateCaseId: "durable-source-writes",
        gateRunRoot: "/tmp/fake-gate",
        gateSummaryJsonPath: "/tmp/fake-gate/summary.json",
        gateSummaryMdPath: "/tmp/fake-gate/summary.md",
        source: "Durable source artifact from a fake deterministic gate.",
      },
    ],
  ]);
}

function seedArtifactInput(): ReadonlyMap<string, QualityArtifactInput> {
  return new Map([
    [
      "first-tree-seed-skeleton-quality",
      {
        artifact: "Phase 1 skeleton proposal with source-backed domains and approval request.",
        deterministicGatePassed: true,
        gateCaseId: "empty-tree-source-present",
        gateRunRoot: "/tmp/fake-seed-gate",
        gateSummaryJsonPath: "/tmp/fake-seed-gate/summary.json",
        gateSummaryMdPath: "/tmp/fake-seed-gate/summary.md",
        source: "Source evidence from a fake seed deterministic gate.",
      },
    ],
  ]);
}

describe("judge schema", () => {
  it("passes good and borderline scores at configured thresholds", () => {
    const parsed = parseJudgeJson(
      JSON.stringify({
        reasoning: "Borderline but acceptable.",
        scores: {
          axis_a: 4,
          axis_b: 3,
        },
      }),
      DIMENSIONS,
    );

    const evaluation = evaluateJudgeOutput(parsed, DIMENSIONS);
    expect(evaluation.passed).toBe(true);
    expect(evaluation.failures).toEqual([]);
    expect(evaluation.judge_scores).toEqual({
      axis_a: 4,
      axis_b: 3,
    });
  });

  it("fails scores below threshold without replacing deterministic pass/fail", () => {
    const parsed = parseJudgeJson(
      JSON.stringify({
        reasoning: "Axis A is too weak.",
        scores: {
          axis_a: 3,
          axis_b: 5,
        },
      }),
      DIMENSIONS,
    );

    const evaluation = evaluateJudgeOutput(parsed, DIMENSIONS);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failures).toEqual(["axis_a: 3 < 4"]);
  });

  it("rejects invalid JSON and schema mismatches", () => {
    expect(() => parseJudgeJson("not json", DIMENSIONS)).toThrow(/not strict JSON/u);
    expect(() =>
      parseJudgeJson(
        JSON.stringify({
          reasoning: "Missing axis B.",
          scores: {
            axis_a: 4,
          },
        }),
        DIMENSIONS,
      ),
    ).toThrow(/axis_b score/u);
  });
});

describe("codex judge provider hardening", () => {
  it("runs judge codex with read-only sandbox and a minimal environment", () => {
    const packageRoot = tempPackageRoot();
    try {
      const paths = createRunPaths({
        caseId: "judge-hardening-test",
        packageRoot,
        startedAt: "2026-06-29T00:00:00.000Z",
      });
      const request = {
        caseId: "judge-hardening-test",
        dimensions: DIMENSIONS,
        prompt: "Return JSON.",
      };
      const env = codexJudgeEnv({
        caseId: request.caseId,
        eventsPath: paths.eventsPath,
        paths,
        sourceEnv: {
          CODEX_HOME: "/codex-auth-home",
          FIRST_TREE_SERVER_URL: "https://example.invalid",
          GIT_CONFIG_GLOBAL: "/tmp/leaky-gitconfig",
          HOME: "/operator-home",
          OPENAI_API_KEY: "allowed",
          PATH: "/usr/bin",
        },
      });
      const args = codexJudgeArgs(request, "gpt-test", paths, env);

      expect(args).toContain("--ignore-user-config");
      expect(args).toContain("--ignore-rules");
      expect(args).toContain("--sandbox");
      expect(args).toContain("read-only");
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(args.at(-1)).toContain("pure text scoring judge");
      expect(env.HOME).toBe(`${paths.runRoot}/judge-home`);
      expect(env.TMPDIR).toBe(`${paths.runRoot}/judge-tmp`);
      expect(env.CODEX_HOME).toBe("/codex-auth-home");
      expect(env.OPENAI_API_KEY).toBe("allowed");
      expect(env.FIRST_TREE_SERVER_URL).toBeUndefined();
      expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
      expect(env.PATH?.startsWith(`${paths.binDir}:`)).toBe(true);
      expect(args).toContain(`shell_environment_policy.set.PATH=${JSON.stringify(env.PATH)}`);
      expect(args).toContain(`shell_environment_policy.set.HOME=${JSON.stringify(env.HOME)}`);
      expect(args).toContain(`shell_environment_policy.set.TMPDIR=${JSON.stringify(env.TMPDIR)}`);
    } finally {
      rmSync(packageRoot, { force: true, recursive: true });
    }
  });
});

describe("quality runner with fake judge", () => {
  it("records judge scores and pass/fail from fake outputs", async () => {
    const packageRoot = tempPackageRoot();
    try {
      const provider = createFakeJudgeProvider(
        new Map([
          [
            "first-tree-write-node-quality",
            JSON.stringify({
              reasoning: "The node is durable and source bounded.",
              scores: {
                conciseness: 4,
                durability: 5,
                rationale_quality: 4,
                source_boundary: 5,
              },
            }),
          ],
        ]),
      );

      const batch = await runQualityEval(
        packageRoot,
        {
          caseId: "first-tree-write-node-quality",
          claudeBin: "unused",
          codexBin: "unused",
          judgeBin: "unused",
          judgeModel: null,
          json: false,
          model: null,
          provider: "codex",
          suite: "first-tree-write",
          verbose: false,
        },
        provider,
        fakeArtifactInput(),
      );

      expect(batch.failed).toBe(0);
      expect(batch.passed).toBe(1);
      expect(batch.cases[0]?.judge_scores).toMatchObject({
        durability: 5,
        source_boundary: 5,
      });
      expect(batch.cases[0]?.judge_model).toBe("fake-judge");
    } finally {
      rmSync(packageRoot, { force: true, recursive: true });
    }
  });

  it("keeps raw invalid judge output and fails the case", async () => {
    const packageRoot = tempPackageRoot();
    try {
      const provider = createFakeJudgeProvider(new Map([["first-tree-write-node-quality", "```json\n{}\n```"]]));

      const batch = await runQualityEval(
        packageRoot,
        {
          caseId: "first-tree-write-node-quality",
          claudeBin: "unused",
          codexBin: "unused",
          judgeBin: "unused",
          judgeModel: null,
          json: false,
          model: null,
          provider: "codex",
          suite: "first-tree-write",
          verbose: false,
        },
        provider,
        fakeArtifactInput(),
      );

      expect(batch.failed).toBe(1);
      expect(batch.cases[0]?.passed).toBe(false);
      expect(batch.cases[0]?.raw_output).toBe("```json\n{}\n```");
      expect(batch.cases[0]?.failures[0]).toMatch(/not strict JSON/u);
    } finally {
      rmSync(packageRoot, { force: true, recursive: true });
    }
  });

  it("fails without calling judge when the deterministic gate artifact failed", async () => {
    const packageRoot = tempPackageRoot();
    try {
      const provider = createFakeJudgeProvider(new Map());

      const batch = await runQualityEval(
        packageRoot,
        {
          caseId: "first-tree-write-node-quality",
          claudeBin: "unused",
          codexBin: "unused",
          judgeBin: "unused",
          judgeModel: null,
          json: false,
          model: null,
          provider: "codex",
          suite: "first-tree-write",
          verbose: false,
        },
        provider,
        failedGateArtifactInput(),
      );

      expect(batch.failed).toBe(1);
      expect(batch.cases[0]?.judge_model).toBe("not-run");
      expect(batch.cases[0]?.failures[0]).toMatch(/deterministic gate durable-source-writes failed/u);
    } finally {
      rmSync(packageRoot, { force: true, recursive: true });
    }
  });

  it("runs the first-tree-seed skeleton quality case with fake judge output", async () => {
    const packageRoot = tempPackageRoot();
    try {
      const provider = createFakeJudgeProvider(
        new Map([
          [
            "first-tree-seed-skeleton-quality",
            JSON.stringify({
              reasoning: "The skeleton is source-grounded and preserves the chat confirmation boundary.",
              scores: {
                conciseness: 4,
                coverage_calibration: 4,
                confirmation_boundary: 5,
                source_grounding: 5,
                structure_fit: 4,
              },
            }),
          ],
        ]),
      );

      const batch = await runQualityEval(
        packageRoot,
        {
          caseId: "first-tree-seed-skeleton-quality",
          claudeBin: "unused",
          codexBin: "unused",
          judgeBin: "unused",
          judgeModel: null,
          json: false,
          model: null,
          provider: "codex",
          suite: "first-tree-seed",
          verbose: false,
        },
        provider,
        seedArtifactInput(),
      );

      expect(batch.failed).toBe(0);
      expect(batch.passed).toBe(1);
      expect(batch.cases[0]?.judge_scores).toMatchObject({
        confirmation_boundary: 5,
        source_grounding: 5,
      });
    } finally {
      rmSync(packageRoot, { force: true, recursive: true });
    }
  });

  it("uses the selected tested-agent provider for standalone quality prerequisite gates", async () => {
    const packageRoot = repoPackageRoot();
    const batch = await runQualityEval(
      packageRoot,
      {
        caseId: "first-tree-seed-skeleton-quality",
        claudeBin: "/bin/false",
        codexBin: "/bin/false",
        judgeBin: "unused",
        judgeModel: null,
        json: false,
        model: "claude-test",
        provider: "claude",
        suite: "first-tree-seed",
        verbose: false,
      },
      createFakeJudgeProvider(new Map()),
    );

    const qualityRunRoot = batch.cases[0]?.runRoot;
    const gateRunRoot = batch.cases[0]?.gateRunRoot;
    try {
      expect(batch.failed).toBe(1);
      expect(batch.cases[0]?.judge_model).toBe("not-run");
      if (gateRunRoot === null || gateRunRoot === undefined) {
        throw new Error("quality run did not record gate run root");
      }
      const gateEvents = readFileSync(join(gateRunRoot, "events.jsonl"), "utf8");
      expect(gateEvents).toContain('"type":"claude_run_started"');
      expect(gateEvents).not.toContain('"type":"codex_run_started"');
    } finally {
      if (qualityRunRoot !== null && qualityRunRoot !== undefined) {
        rmSync(qualityRunRoot, { force: true, recursive: true });
      }
      if (gateRunRoot !== null && gateRunRoot !== undefined) {
        rmSync(gateRunRoot, { force: true, recursive: true });
      }
    }
  });
});

describe("quality rubric sanity fixtures", () => {
  it("keeps first-tree-write good, borderline, and bad fixtures aligned with thresholds", () => {
    for (const fixture of FIRST_TREE_WRITE_QUALITY_SANITY_FIXTURES) {
      const prompt = FIRST_TREE_WRITE_QUALITY_DEFINITION.buildJudgePrompt(fixture.input);
      const evaluation = evaluateJudgeOutput(
        parseJudgeJson(fixture.judgeOutput, FIRST_TREE_WRITE_QUALITY_DEFINITION.dimensions),
        FIRST_TREE_WRITE_QUALITY_DEFINITION.dimensions,
      );

      expect(prompt).toContain(fixture.input.artifact);
      expect(prompt).toContain(fixture.input.source);
      expect(evaluation.passed, fixture.name).toBe(fixture.expectedPassed);
    }
  });

  it("keeps first-tree-welcome good, borderline, and bad fixtures aligned with thresholds", () => {
    for (const fixture of FIRST_TREE_WELCOME_QUALITY_SANITY_FIXTURES) {
      const prompt = FIRST_TREE_WELCOME_QUALITY_DEFINITION.buildJudgePrompt(fixture.input);
      const evaluation = evaluateJudgeOutput(
        parseJudgeJson(fixture.judgeOutput, FIRST_TREE_WELCOME_QUALITY_DEFINITION.dimensions),
        FIRST_TREE_WELCOME_QUALITY_DEFINITION.dimensions,
      );

      expect(prompt).toContain(fixture.input.artifact);
      expect(prompt).toContain(fixture.input.source);
      expect(evaluation.passed, fixture.name).toBe(fixture.expectedPassed);
    }
  });

  it("keeps first-tree-seed good, borderline, and bad fixtures aligned with thresholds", () => {
    for (const fixture of FIRST_TREE_SEED_QUALITY_SANITY_FIXTURES) {
      const prompt = FIRST_TREE_SEED_QUALITY_DEFINITION.buildJudgePrompt(fixture.input);
      const evaluation = evaluateJudgeOutput(
        parseJudgeJson(fixture.judgeOutput, FIRST_TREE_SEED_QUALITY_DEFINITION.dimensions),
        FIRST_TREE_SEED_QUALITY_DEFINITION.dimensions,
      );

      expect(prompt).toContain(fixture.input.artifact);
      expect(prompt).toContain(fixture.input.source);
      expect(evaluation.passed, fixture.name).toBe(fixture.expectedPassed);
    }
  });
});
