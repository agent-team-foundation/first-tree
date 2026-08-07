import type { AgentProviderName } from "../../core/provider/types.js";
import type { SkillCaseGrading } from "../../core/result-schema.js";
import type { CommandResult } from "../../core/types.js";

export type WorkspaceKind = "blank" | "byo-context-tree" | "context-tree";
export type BriefingMode = "minimal" | "runtime-generated";
export type ReadMode = "byo" | "managed";
export type ManagedTransport = "ask" | "send";

export type ImpactNoteEffect = "conflicted" | "confirmed" | "constrained" | "redirected";
export type ImpactNoteLanguage = "en" | "zh";

export type ImpactNoteExpectation =
  | { mode: "absent" }
  | {
      effect: ImpactNoteEffect;
      language: ImpactNoteLanguage;
      mode: "present";
      requiredSourceLabels?: readonly string[];
      sourceAuthority: {
        allowedNodePaths: readonly string[];
        exactCommit?: string;
        repository: string;
      };
      sourceCount: { max: number; min: number };
      summaryConcepts?: readonly (readonly string[])[];
      summaryForbidden?: readonly string[];
    };

export type FirstTreeReadEvalCase = {
  briefingMode?: BriefingMode;
  description: string;
  expectedFacts: readonly string[];
  expectedTrigger: boolean;
  id: string;
  impactNote: ImpactNoteExpectation;
  managedTransport: ManagedTransport | null;
  prompt: string;
  promptAlternates: readonly string[];
  readMode: ReadMode;
  workspaceKind: WorkspaceKind;
};

export type FixtureValidation = {
  domainNodeCount: number;
  errors: readonly string[];
  minDepthOk: boolean;
  ok: boolean;
  requiredFilesOk: boolean;
  verifyResult: CommandResult | null;
};

export type CliOptions = {
  caseId: string | null;
  claudeBin: string;
  codexBin: string;
  json: boolean;
  model: string | null;
  provider: AgentProviderName;
  verbose: boolean;
};

export type EvalMetrics = {
  expectedFactHits: readonly string[];
  expectedFactsObserved: boolean;
  firstTreeArgv: readonly (readonly string[])[];
  firstTreeCalls: number;
  firstTreeCommandResults: readonly {
    argv: readonly string[];
    exitCode: number;
  }[];
  fixtureValidationOk: boolean;
  helpAttempted: boolean;
  helpCalls: number;
  helpExitCodes: readonly number[];
  helpSucceeded: boolean;
  impactNoteBehaviorOk: boolean;
  impactNoteBlankLineBefore: boolean;
  impactNoteCount: number;
  impactNoteEffect: string | null;
  impactNoteAtFinalEnd: boolean;
  impactNoteExactLinksOk: boolean;
  impactNoteLanguage: ImpactNoteLanguage | null;
  impactNoteLogicalLinesOk: boolean;
  impactNoteMetadataFree: boolean;
  impactNoteOutsideBlockingAsk: boolean;
  impactNoteSourceAuthorityOk: boolean;
  impactNoteSourceCount: number;
  impactNoteSourceLabels: readonly string[];
  impactNoteSummaryConceptsOk: boolean;
  impactNoteSummaryForbiddenOk: boolean;
  impactNoteSummaryObjectiveOk: boolean;
  impactNoteVisibleUrlsCredentialFree: boolean;
  byoReadSequenceOk: boolean;
  byoSelectorsNoPull: boolean;
  byoSnapshotDetached: boolean;
  byoSnapshotExactHeadConsistent: boolean;
  managedFinalTransportOk: boolean;
  /** The delivery actually used by the last successful authoring call. */
  managedFinalTransportKind: ManagedTransport | null;
  /** The delivery this case's task contract requires, when it declares one. */
  managedTransportExpected: ManagedTransport | null;
  legacyReadActivationCalls: number;
  modelFirstTreeCommandsOk: boolean;
  readActivationCalls: number;
  readActivationSucceeded: boolean;
  readRouteCalls: number;
  readRouteSucceeded: boolean;
  runnerExitCode: number | null;
  selectionSucceeded: boolean;
  skillFileReadObserved: boolean;
  skillHit: boolean;
};

export type CaseRunSummary = {
  caseId: string;
  driftNote: string | null;
  expectedTrigger: boolean;
  firstResponseLatencyMs: number | null;
  fixtureValidation: FixtureValidation;
  grading: SkillCaseGrading;
  gradingJsonPath: string;
  metrics: EvalMetrics;
  passed: boolean;
  prompt: string;
  readMode: ReadMode;
  runRoot: string;
  startedAt: string;
  summaryJsonPath: string;
  summaryMdPath: string;
  turns: number | null;
  workspacePath: string;
};

export type BatchSummary = {
  cases: readonly CaseRunSummary[];
  failed: number;
  passed: number;
  runStartedAt: string;
};
