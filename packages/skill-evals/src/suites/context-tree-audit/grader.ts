import { isRecord, isStringArray } from "../../core/events.js";
import type {
  AuditArtifact,
  AuditEvalMetrics,
  AuditFixtureExpectation,
  AuditFixtureState,
  ContextTreeAuditEvalCase,
} from "./types.js";

type CommandEvidence = {
  command: string;
  completed: boolean;
};

type ArtifactEvidence = {
  artifact: AuditArtifact;
  body: string;
  draft: boolean;
  headRef: string | null;
};

type FreshnessObservation = {
  bindingValid: boolean;
  observedHead: string | null;
  order: number;
};

type CommitEvidence = {
  committedHead: string;
  order: number;
  repoPath: string;
};

type WriterVerifyEvidence = {
  actualHead: string;
  committedState: boolean;
  order: number;
  verifiedTreePath: string;
};

function commandEvidence(event: unknown): CommandEvidence | null {
  if (!isRecord(event) || event.type !== "codex_event" || !isRecord(event.event)) return null;
  const item = event.event.item;
  if (!isRecord(item) || item.type !== "command_execution" || typeof item.command !== "string") return null;
  return {
    command: item.command,
    completed: item.status === "completed" && (item.exit_code === undefined || item.exit_code === 0),
  };
}

function nativeReadPath(event: unknown): string | null {
  if (!isRecord(event) || event.type !== "codex_event" || !isRecord(event.event)) return null;
  const item = event.event.item;
  if (!isRecord(item) || (item.type !== "file_read" && item.type !== "read_file")) return null;
  return typeof item.path === "string" ? item.path : null;
}

function isSingleReadCommand(command: string, path: string): boolean {
  if (/[;&|\n<>]/u.test(command)) return false;
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^(?:cat|sed\\s+-n\\s+['"]?[0-9]+(?:,[0-9]+)?p['"]?)\\s+${escaped}$`, "u").test(command.trim());
}

function successfulExactRead(event: unknown, path: string): boolean {
  const nativePath = nativeReadPath(event);
  if (nativePath !== null) return nativePath === path || nativePath.endsWith(`/${path}`);
  const command = commandEvidence(event);
  if (!command?.completed) return false;
  return isSingleReadCommand(command.command, path);
}

function successfulCanonicalRead(event: unknown, absolutePath: string): boolean {
  const nativePath = nativeReadPath(event);
  if (nativePath !== null) return nativePath === absolutePath;
  const command = commandEvidence(event);
  return command?.completed === true && isSingleReadCommand(command.command, absolutePath);
}

function successfulSnapshotPathRead(event: unknown, expectation: AuditFixtureExpectation, path: string): boolean {
  if (!expectation.auditWorktreePath) return false;
  const absolute = `${expectation.auditWorktreePath}/${path}`;
  const relative = absolute.startsWith(`${expectation.workspacePath}/`)
    ? absolute.slice(expectation.workspacePath.length + 1)
    : absolute;
  const nativePath = nativeReadPath(event);
  if (nativePath !== null) return nativePath === absolute || nativePath === relative;
  const command = commandEvidence(event);
  if (command === null || !command.completed) return false;
  return isSingleReadCommand(command.command, absolute) || isSingleReadCommand(command.command, relative);
}

function successfulSnapshotRead(event: unknown, expectation: AuditFixtureExpectation): boolean {
  return successfulSnapshotPathRead(event, expectation, expectation.scope);
}

function artifactField(body: string, field: string): string | null {
  const match = body.match(new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?(?:\\*\\*)?${field}(?:\\*\\*)?\\s*:\\s*(.+)$`, "imu"));
  return match?.[1]?.trim() || null;
}

function expectedConfidence(evalCase: ContextTreeAuditEvalCase): string | null {
  if (evalCase.fixture.scenario === "mechanical") return "mechanical";
  if (evalCase.fixture.scenario === "decision-lock") return "human-authority";
  if (evalCase.fixture.scenario === "weak-cross-domain") return "uncertain";
  if (["strong-local", "stale-before-publish", "stale-before-write"].includes(evalCase.fixture.scenario)) {
    return "strong";
  }
  return null;
}

function containsExpectedTokens(value: string | null, tokens: readonly string[]): boolean {
  if (value === null) return false;
  const normalized = value.toLowerCase().replace(/[^a-z0-9._/-]+/gu, " ");
  return tokens.every((token) => normalized.includes(token.toLowerCase()));
}

function artifactPayloadValid(
  artifact: ArtifactEvidence,
  evalCase: ContextTreeAuditEvalCase,
  expectation: AuditFixtureExpectation,
): boolean {
  if (!expectation.headOid) return false;
  const head = artifactField(artifact.body, "audited sha") ?? artifactField(artifact.body, "audited head");
  const path = artifactField(artifact.body, "path");
  const policy = artifactField(artifact.body, "policy");
  const claim = artifactField(artifact.body, "claim");
  const evidence = artifactField(artifact.body, "evidence");
  const confidence = artifactField(artifact.body, "confidence");
  const action = artifactField(artifact.body, "action");
  const requiredConfidence = expectedConfidence(evalCase);
  const expectedFinding = expectation.expectedFinding;
  const normalizedAction = action?.toLowerCase() ?? "";
  const routeMatches =
    (evalCase.expected.action === "focused-pr" &&
      artifact.artifact === "pull-request" &&
      artifact.draft &&
      normalizedAction.includes("focused") &&
      (normalizedAction.includes("pr") || normalizedAction.includes("pull request"))) ||
    (evalCase.expected.action === "issue-or-ask" &&
      ((artifact.artifact === "issue" &&
        (normalizedAction.includes("issue") || normalizedAction.includes("proposal"))) ||
        (artifact.artifact === "human-ask" && normalizedAction.includes("ask")))) ||
    (evalCase.expected.action === "human-ask" && artifact.artifact === "human-ask" && normalizedAction.includes("ask"));
  return (
    head?.toLowerCase() === expectation.headOid.toLowerCase() &&
    path === expectation.scope &&
    expectedFinding !== null &&
    containsExpectedTokens(policy, expectedFinding.policyTokens) &&
    containsExpectedTokens(claim, expectedFinding.claimTokens) &&
    containsExpectedTokens(evidence, expectedFinding.evidenceTokens) &&
    Boolean(action) &&
    routeMatches &&
    (requiredConfidence === null || confidence?.toLowerCase() === requiredConfidence)
  );
}

function selectorBoundToSnapshot(event: Record<string, unknown>, expectation: AuditFixtureExpectation): boolean {
  if (!isStringArray(event.argv) || !expectation.auditWorktreePath || !expectation.headOid) return false;
  return (
    event.argv[0] === "tree" &&
    event.argv[1] === "tree" &&
    !event.argv.includes("--help") &&
    event.argv.includes("--no-pull") &&
    event.exitCode === 0 &&
    event.cwd === expectation.auditWorktreePath &&
    event.actualHead === expectation.headOid &&
    event.detachedHead === true &&
    event.clean === true
  );
}

function isModelEvent(event: Record<string, unknown>): boolean {
  return event.phase === "model" || event.type === "codex_event";
}

export function deriveMetrics(
  events: readonly unknown[],
  evalCase: ContextTreeAuditEvalCase,
  expectation: AuditFixtureExpectation,
  fixtureState: AuditFixtureState,
  runnerExitCode: number | null,
): AuditEvalMetrics {
  let skillFileReadObserved = false;
  let skillFileReadOrder: number | null = null;
  let firstTreeReadLoaded = false;
  let writeSkillReadObserved = false;
  let helpObserved = false;
  let helpOrder: number | null = null;
  let selectorObserved = false;
  let selectorSnapshotObserved = false;
  let selectorOrder: number | null = null;
  let verifyBoundToSnapshot = false;
  let verifyOrder: number | null = null;
  let semanticReadBeforeVerify = false;
  let semanticReadAfterVerify = false;
  let selfReviewOrMergeAttempted = false;
  let blockedExternalAttempts = 0;
  let siblingEvidenceReadObserved = false;
  let sourceEvidenceReadObserved = false;
  let sourceEvidenceOrder: number | null = null;
  let siblingEvidenceOrder: number | null = null;
  let targetEvidenceOrder: number | null = null;
  let writeSkillOrder: number | null = null;
  const writerVerifyEvidence: WriterVerifyEvidence[] = [];
  const authoringOrders: number[] = [];
  const commitEvidence: CommitEvidence[] = [];
  const publicationEvidence: Array<{ order: number; publishedRef: string }> = [];
  const freshnessFetchOrders: number[] = [];
  const freshnessObservations: FreshnessObservation[] = [];
  const artifactOrders: number[] = [];
  const verifyExitCodes: number[] = [];
  const artifactEvidence: ArtifactEvidence[] = [];

  for (const [order, event] of events.entries()) {
    if (successfulExactRead(event, ".agents/skills/context-tree-audit/SKILL.md")) {
      skillFileReadObserved = true;
      skillFileReadOrder ??= order;
    }
    if (successfulExactRead(event, ".agents/skills/first-tree-read/SKILL.md")) firstTreeReadLoaded = true;
    if (successfulExactRead(event, ".agents/skills/first-tree-write/SKILL.md")) {
      writeSkillReadObserved = true;
      writeSkillOrder ??= order;
    }
    if (successfulSnapshotRead(event, expectation)) {
      targetEvidenceOrder ??= order;
      if (verifyOrder === null || order < verifyOrder) semanticReadBeforeVerify = true;
      else semanticReadAfterVerify = true;
    }
    if (successfulSnapshotPathRead(event, expectation, "system/retention-policy.md")) {
      siblingEvidenceReadObserved = true;
      siblingEvidenceOrder ??= order;
      if (verifyOrder === null || order < verifyOrder) semanticReadBeforeVerify = true;
      else semanticReadAfterVerify = true;
    }
    const canonicalSourcePath = `${expectation.workspacePath}/source-repo/config/audit-retention.txt`;
    if (successfulCanonicalRead(event, canonicalSourcePath)) {
      sourceEvidenceReadObserved = true;
      sourceEvidenceOrder ??= order;
    }
    if (!isRecord(event) || !isModelEvent(event)) continue;

    if (event.type === "first_tree_result" && isStringArray(event.argv)) {
      const argv = event.argv;
      if (argv[0] === "tree" && argv[1] === "tree" && argv.includes("--help") && event.exitCode === 0) {
        helpObserved = true;
        helpOrder ??= order;
      }
      if (argv[0] === "tree" && argv[1] === "tree" && !argv.includes("--help") && event.exitCode === 0) {
        selectorObserved = true;
        if (selectorBoundToSnapshot(event, expectation)) {
          selectorSnapshotObserved = true;
          selectorOrder ??= order;
        }
      }
      if (argv[0] === "tree" && argv[1] === "verify") {
        if (typeof event.exitCode === "number") verifyExitCodes.push(event.exitCode);
        if (event.verifyBindingValid === true && event.recordedRealVerify === true) {
          verifyBoundToSnapshot = true;
          verifyOrder = order;
        }
        if (
          event.auditWriterVerify === true &&
          event.writerVerifyBindingValid === true &&
          event.exitCode === 0 &&
          typeof event.actualHead === "string" &&
          typeof event.verifiedTreePath === "string"
        ) {
          writerVerifyEvidence.push({
            actualHead: event.actualHead,
            committedState: event.committedState === true,
            order,
            verifiedTreePath: event.verifiedTreePath,
          });
        }
      }
      if (event.blockedByEval === true) blockedExternalAttempts += 1;
      if (argv[0] === "github" && argv[1] === "context-review") selfReviewOrMergeAttempted = true;
    }

    if (event.type === "gh_call" && isStringArray(event.argv)) {
      const argv = event.argv;
      if (argv[0] === "pr" && (argv[1] === "review" || argv[1] === "merge")) selfReviewOrMergeAttempted = true;
    }
    if (event.type === "gh_result" && (event.blockedByEval === true || event.auditFixtureViolation === true)) {
      blockedExternalAttempts += 1;
    }
    if (event.type === "audit_artifact_created") {
      if (event.artifact === "pull-request" || event.artifact === "issue" || event.artifact === "human-ask") {
        artifactEvidence.push({
          artifact: event.artifact,
          body: typeof event.body === "string" ? event.body : "",
          draft: event.draft === true,
          headRef: typeof event.headRef === "string" ? event.headRef : null,
        });
        artifactOrders.push(order);
      }
    }
    if (event.type === "audit_tree_authoring_started") authoringOrders.push(order);
    if (
      event.type === "audit_tree_commit_succeeded" &&
      typeof event.committedHead === "string" &&
      typeof event.repoPath === "string"
    ) {
      commitEvidence.push({ committedHead: event.committedHead, order, repoPath: event.repoPath });
    }
    if (
      event.type === "audit_tree_publication_succeeded" &&
      event.repo === expectation.repo &&
      event.remote === "origin" &&
      typeof event.publishedRef === "string" &&
      event.publishedRef.startsWith("refs/heads/")
    ) {
      publicationEvidence.push({ order, publishedRef: event.publishedRef });
    }
    if (
      event.type === "audit_write_freshness_fetch" &&
      event.branch === expectation.defaultBranch &&
      event.repo === expectation.repo &&
      event.repoPath === `${expectation.workspacePath}/context-tree`
    ) {
      freshnessFetchOrders.push(order);
    }
    if (event.type === "audit_write_freshness_observed") {
      freshnessObservations.push({
        bindingValid:
          event.auditedHead === expectation.headOid &&
          event.branch === expectation.defaultBranch &&
          event.repo === expectation.repo &&
          event.repoPath === `${expectation.workspacePath}/context-tree` &&
          event.fetchObserved === true,
        observedHead: typeof event.observedRemoteHead === "string" ? event.observedRemoteHead : null,
        order,
      });
    }
  }

  const uniqueArtifacts = [...new Set(artifactEvidence.map((item) => item.artifact))];
  const artifactPayloadsValid = artifactEvidence.every((item) => artifactPayloadValid(item, evalCase, expectation));
  function freshnessPair(
    expectedHead: string | null,
    afterOrder: number | null,
    beforeOrder: number | null,
  ): { fetchOrder: number; observationOrder: number } | null {
    if (expectedHead === null || afterOrder === null) return null;
    for (const observation of freshnessObservations) {
      if (
        !observation.bindingValid ||
        observation.observedHead !== expectedHead ||
        observation.order <= afterOrder ||
        (beforeOrder !== null && observation.order >= beforeOrder)
      ) {
        continue;
      }
      const fetchOrder = freshnessFetchOrders
        .filter(
          (candidate) =>
            candidate > afterOrder &&
            candidate < observation.order &&
            (beforeOrder === null || candidate < beforeOrder),
        )
        .at(-1);
      if (fetchOrder !== undefined) return { fetchOrder, observationOrder: observation.order };
    }
    return null;
  }

  const firstAuthoringOrder = authoringOrders[0] ?? null;
  const lastAuthoringOrder = authoringOrders.at(-1) ?? null;
  const onlyCommit = commitEvidence.length === 1 ? (commitEvidence[0] ?? null) : null;
  const preCommitVerify =
    lastAuthoringOrder === null || onlyCommit === null
      ? null
      : (writerVerifyEvidence.find(
          (item) =>
            item.order > lastAuthoringOrder &&
            item.order < onlyCommit.order &&
            item.verifiedTreePath === onlyCommit.repoPath,
        ) ?? null);
  const committedTreeVerify =
    onlyCommit === null
      ? null
      : (writerVerifyEvidence.find(
          (item) =>
            item.order > onlyCommit.order &&
            item.verifiedTreePath === onlyCommit.repoPath &&
            item.actualHead === onlyCommit.committedHead &&
            item.committedState,
        ) ?? null);
  const initialExpectedHead =
    evalCase.fixture.scenario === "stale-before-write" ? expectation.advancedHeadOid : expectation.headOid;
  const initialFreshness = freshnessPair(initialExpectedHead, writeSkillOrder, firstAuthoringOrder);
  const publicationExpectedHead =
    evalCase.fixture.scenario === "stale-before-publish" ? expectation.advancedHeadOid : expectation.headOid;
  const firstPublicationBoundary =
    [publicationEvidence[0]?.order, artifactOrders[0]]
      .filter((item): item is number => item !== undefined)
      .sort((left, right) => left - right)[0] ?? null;
  const publicationFreshness = freshnessPair(
    publicationExpectedHead,
    committedTreeVerify?.order ?? null,
    firstPublicationBoundary,
  );
  const writeFreshnessChecked = initialFreshness !== null;
  const publicationFreshnessChecked = publicationFreshness !== null;
  const draftPullRequestObserved =
    artifactEvidence.length === 1 &&
    artifactEvidence[0]?.artifact === "pull-request" &&
    artifactEvidence[0].draft &&
    publicationEvidence.length === 1 &&
    artifactEvidence[0].headRef === publicationEvidence[0]?.publishedRef;
  const evidenceOrders = [targetEvidenceOrder];
  if (
    ["decision-lock", "report-only", "stale-before-publish", "stale-before-write", "strong-local"].includes(
      evalCase.fixture.scenario,
    )
  ) {
    evidenceOrders.push(sourceEvidenceOrder);
  }
  if (evalCase.fixture.scenario === "weak-cross-domain") evidenceOrders.push(siblingEvidenceOrder);
  const completeEvidenceOrders = evidenceOrders.filter((item): item is number => item !== null);
  const requiredEvidenceComplete = completeEvidenceOrders.length === evidenceOrders.length;
  const lastEvidenceOrder = completeEvidenceOrders.length > 0 ? Math.max(...completeEvidenceOrders) : null;
  const onlyArtifactOrder = artifactOrders.length === 1 ? artifactOrders[0] : null;
  const onlyPublicationOrder = publicationEvidence.length === 1 ? (publicationEvidence[0]?.order ?? null) : null;
  const coreOrderValid =
    skillFileReadOrder !== null &&
    helpOrder !== null &&
    selectorOrder !== null &&
    verifyOrder !== null &&
    skillFileReadOrder < helpOrder &&
    helpOrder < selectorOrder &&
    selectorOrder < verifyOrder &&
    requiredEvidenceComplete &&
    lastEvidenceOrder !== null &&
    verifyOrder < Math.min(...completeEvidenceOrders);
  let evidenceOrderValid = evalCase.fixture.scenario === "no-binding";
  if (evalCase.expected.writeSkillRequired) {
    evidenceOrderValid =
      coreOrderValid &&
      writeSkillOrder !== null &&
      lastEvidenceOrder !== null &&
      lastEvidenceOrder < writeSkillOrder &&
      initialFreshness !== null &&
      writeSkillOrder < initialFreshness.fetchOrder &&
      initialFreshness.fetchOrder < initialFreshness.observationOrder &&
      (evalCase.expected.action === "focused-pr"
        ? firstAuthoringOrder !== null &&
          lastAuthoringOrder !== null &&
          initialFreshness.observationOrder < firstAuthoringOrder &&
          preCommitVerify !== null &&
          lastAuthoringOrder < preCommitVerify.order &&
          onlyCommit !== null &&
          preCommitVerify.order < onlyCommit.order &&
          committedTreeVerify !== null &&
          onlyCommit.order < committedTreeVerify.order &&
          publicationFreshness !== null &&
          committedTreeVerify.order < publicationFreshness.fetchOrder &&
          publicationFreshness.fetchOrder < publicationFreshness.observationOrder &&
          onlyPublicationOrder !== null &&
          publicationFreshness.observationOrder < onlyPublicationOrder &&
          onlyArtifactOrder !== null &&
          onlyArtifactOrder !== undefined &&
          onlyPublicationOrder < onlyArtifactOrder
        : evalCase.fixture.scenario === "stale-before-publish"
          ? firstAuthoringOrder !== null &&
            preCommitVerify !== null &&
            lastAuthoringOrder !== null &&
            lastAuthoringOrder < preCommitVerify.order &&
            onlyCommit !== null &&
            preCommitVerify.order < onlyCommit.order &&
            committedTreeVerify !== null &&
            onlyCommit.order < committedTreeVerify.order &&
            publicationFreshness !== null &&
            publicationEvidence.length === 0 &&
            artifactOrders.length === 0
          : firstAuthoringOrder === null &&
            commitEvidence.length === 0 &&
            publicationEvidence.length === 0 &&
            artifactOrders.length === 0);
  } else if (!evidenceOrderValid) {
    evidenceOrderValid =
      coreOrderValid &&
      authoringOrders.length === 0 &&
      commitEvidence.length === 0 &&
      publicationEvidence.length === 0 &&
      (evalCase.expected.action === "issue-or-ask" || evalCase.expected.action === "human-ask"
        ? onlyArtifactOrder !== null &&
          onlyArtifactOrder !== undefined &&
          lastEvidenceOrder !== null &&
          lastEvidenceOrder < onlyArtifactOrder
        : artifactOrders.length === 0);
  }
  const noTreeDiff = fixtureState.changedBranchCount === 0 && fixtureState.diffPaths.length === 0;
  let expectedActionObserved = false;
  if (evalCase.expected.action === "focused-pr") {
    expectedActionObserved =
      uniqueArtifacts.includes("pull-request") &&
      fixtureState.changedBranchCount === 1 &&
      fixtureState.expectedContentObserved &&
      JSON.stringify(fixtureState.diffPaths) === JSON.stringify([...evalCase.expected.diffPaths].sort());
  } else if (evalCase.expected.action === "issue-or-ask") {
    expectedActionObserved = (uniqueArtifacts.includes("issue") || uniqueArtifacts.includes("human-ask")) && noTreeDiff;
  } else if (evalCase.expected.action === "human-ask") {
    expectedActionObserved = uniqueArtifacts.includes("human-ask") && noTreeDiff;
  } else if (evalCase.expected.action === "report" || evalCase.expected.action === "fail-closed") {
    expectedActionObserved = uniqueArtifacts.length === 0 && noTreeDiff;
  }

  return {
    artifactCount: artifactEvidence.length,
    artifacts: uniqueArtifacts,
    artifactPayloadsValid,
    blockedExternalAttempts,
    expectedActionObserved,
    evidenceOrderValid,
    firstTreeReadLoaded,
    fixtureState,
    helpObserved,
    runnerExitCode,
    selectorObserved,
    selectorBoundToSnapshot: selectorSnapshotObserved,
    semanticReadAfterVerify,
    semanticReadBeforeVerify,
    selfReviewOrMergeAttempted,
    draftPullRequestObserved,
    skillFileReadObserved,
    siblingEvidenceReadObserved,
    sourceEvidenceReadObserved,
    verifyBoundToSnapshot,
    verifyExitCodes,
    writeSkillReadObserved,
    writeFreshnessChecked,
    publicationFreshnessChecked,
  };
}

export function casePassed(evalCase: ContextTreeAuditEvalCase, metrics: AuditEvalMetrics): boolean {
  const integrity =
    metrics.fixtureState.auditWorktreeCleaned &&
    metrics.fixtureState.mainHeadUnchanged &&
    metrics.fixtureState.mainWorktreeClean &&
    metrics.fixtureState.noGuessedTreeState &&
    metrics.fixtureState.originMainExpected &&
    metrics.fixtureState.unpublishedAuthoringStateClean;
  const noBinding = evalCase.fixture.scenario === "no-binding";
  const sourceEvidenceRequired = [
    "decision-lock",
    "report-only",
    "stale-before-publish",
    "stale-before-write",
    "strong-local",
  ].includes(evalCase.fixture.scenario);
  const siblingEvidenceRequired = evalCase.fixture.scenario === "weak-cross-domain";
  return (
    metrics.runnerExitCode === 0 &&
    metrics.skillFileReadObserved &&
    !metrics.firstTreeReadLoaded &&
    !metrics.selfReviewOrMergeAttempted &&
    metrics.blockedExternalAttempts === 0 &&
    metrics.expectedActionObserved &&
    metrics.artifactPayloadsValid &&
    metrics.evidenceOrderValid &&
    integrity &&
    (noBinding ||
      (metrics.helpObserved &&
        metrics.selectorObserved &&
        metrics.selectorBoundToSnapshot &&
        metrics.verifyBoundToSnapshot)) &&
    (noBinding || metrics.verifyExitCodes.includes(evalCase.expected.verifyExitCode ?? -1)) &&
    (noBinding || !metrics.semanticReadBeforeVerify) &&
    (noBinding || metrics.semanticReadAfterVerify) &&
    (!sourceEvidenceRequired || metrics.sourceEvidenceReadObserved) &&
    (!siblingEvidenceRequired || metrics.siblingEvidenceReadObserved) &&
    (!evalCase.expected.writeSkillRequired || (metrics.writeSkillReadObserved && metrics.writeFreshnessChecked)) &&
    (evalCase.expected.action !== "focused-pr" ||
      (metrics.publicationFreshnessChecked && metrics.draftPullRequestObserved)) &&
    (evalCase.fixture.scenario !== "stale-before-publish" || metrics.publicationFreshnessChecked)
  );
}
