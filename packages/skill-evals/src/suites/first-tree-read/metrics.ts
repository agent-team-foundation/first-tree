import { findStringValue, isRecord, isStringArray } from "../../core/events.js";
import type {
  EvalMetrics,
  FixtureValidation,
  ImpactNoteEffect,
  ImpactNoteExpectation,
  ImpactNoteLanguage,
  ManagedTransport,
  ReadMode,
} from "./types.js";

const HELP_ARGV = ["tree", "tree", "--help"];
const TEXT_KEYS = ["content", "message", "output_text", "text"];

type FactMatcher = {
  all: readonly RegExp[];
  fact: string;
};

const FACT_MATCHERS: readonly FactMatcher[] = [
  {
    all: [
      /user\s+jwt/iu,
      /((?:unified(?:\s+user\s+jwt)?|single)\s+authorization surface|single authorization model|统一[^。\n]*授权|统一[^。\n]*身份模型)/iu,
    ],
    fact: "User JWT auth is the unified authorization surface.",
  },
  {
    all: [
      /(route scopes?|scope rules?|scopes?)/iu,
      /(live organization membership|live org(?:anization)? membership|当前[^。\n]*membership|membership checks?)/iu,
    ],
    fact: "Route scopes must be checked against live organization membership before cross-org actions.",
  },
  {
    all: [
      /(http[^。\n]*routes?|auth[^。\n]*routes?|multi-org|jwt auth)/iu,
      /(docs\/development\/http-path-conventions\.md|path conventions?|路径约定)/iu,
    ],
    fact: "HTTP routes must follow the repo path conventions document before auth or multi-org changes.",
  },
  {
    all: [/(top-level|顶层)/iu, /(systems?|系统)/iu, /(domains?|领域)/iu, /(operations?|运维|操作)/iu],
    fact: "Top-level Context Tree domains are systems, domains, and operations.",
  },
  {
    all: [
      /(production release|生产发布|正式发布)/iu,
      /(security[- ]audit|安全审计)/iu,
      /(before deployment|发布前|部署前)/iu,
    ],
    fact: "Production releases require completed security-audit approval before deployment.",
  },
  {
    all: [
      /(production rollout|生产发布|正式发布)/iu,
      /(single reviewable scope|统一[^。\n]*审查范围|单一[^。\n]*范围)/iu,
    ],
    fact: "Every production rollout must keep a single reviewable scope across release and billing policy.",
  },
  {
    all: [/(billing changes?|计费变更)/iu, /(core release|核心版本|核心发布)/iu, /(stable monitoring|稳定监控)/iu],
    fact: "Billing changes must roll out after the core release reaches stable monitoring.",
  },
];

const EFFECT_LABELS: Record<ImpactNoteLanguage, Record<ImpactNoteEffect, string>> = {
  en: {
    conflicted: "Conflict surfaced",
    confirmed: "Direction supported",
    constrained: "Options narrowed",
    redirected: "Approach changed",
  },
  zh: {
    conflicted: "发现约束冲突",
    confirmed: "支持当前方向",
    constrained: "收窄可选范围",
    redirected: "改变方案路径",
  },
};

type ImpactNoteObservation = {
  atEnd: boolean;
  blankLineBefore: boolean;
  effectLabel: string;
  exactLinksOk: boolean;
  language: ImpactNoteLanguage;
  logicalLinesOk: boolean;
  sourceLabels: readonly string[];
  sourceScaffoldingOk: boolean;
  sourceUrls: readonly string[];
  summary: string;
  summaryObjectiveOk: boolean;
  textIndex: number;
};

type ExactSourceLink = {
  commit: string;
  nodePath: string;
  repositoryIdentity: string;
};

function canonicalRepositoryIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/iu, "");
    return path.length > 0 ? `${url.host.toLowerCase()}/${path.toLowerCase()}` : null;
  } catch {
    const scpMatch = /^(?:[^@\s]+@)?([^:\s]+):(.+)$/u.exec(value.trim());
    if (!scpMatch) return null;
    const host = scpMatch[1]?.toLowerCase() ?? "";
    const path = (scpMatch[2] ?? "")
      .replace(/^\/+|\/+$/gu, "")
      .replace(/\.git$/iu, "")
      .toLowerCase();
    return host.length > 0 && path.length > 0 ? `${host}/${path}` : null;
  }
}

function parseExactCredentialFreeSourceLink(value: string): ExactSourceLink | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    const blobIndex = segments.findIndex(
      (segment, index) =>
        segment === "blob" && /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u.test(segments[index + 1] ?? ""),
    );
    if (blobIndex <= 0 || blobIndex + 2 >= segments.length) return null;
    const repositoryEnd = segments[blobIndex - 1] === "-" ? blobIndex - 1 : blobIndex;
    if (repositoryEnd <= 0) return null;

    const repositoryPath = segments
      .slice(0, repositoryEnd)
      .join("/")
      .replace(/\.git$/iu, "");
    const nodePath = segments
      .slice(blobIndex + 2)
      .map((segment) => decodeURIComponent(segment))
      .join("/");
    if (repositoryPath.length === 0 || nodePath.length === 0) return null;

    return {
      commit: segments[blobIndex + 1]?.toLowerCase() ?? "",
      nodePath,
      repositoryIdentity: `${url.host.toLowerCase()}/${repositoryPath.toLowerCase()}`,
    };
  } catch {
    return null;
  }
}

function isObjectiveImpactSummary(summary: string): boolean {
  const hasEnglishFirstPerson =
    /\b(?:we|We|our|Our|my|My|me|Me|us|Us|ours|Ours|mine|Mine)\b(?!-)/u.test(summary) ||
    /(?<!\bphase )\bi\b(?![/-])/iu.test(summary);
  const hasFirstPerson =
    hasEnglishFirstPerson ||
    /我们|我的|(^|[\s，。！？，；：])我(?=[\s，。！？，；：]|使用|读取|参考|认为|选择|决定)/u.test(summary);
  const withoutAbbreviationPeriods = summary.replace(/\b(?:[A-Za-z]\.){2,}/gu, (value) => value.replaceAll(".", ""));
  const hasMultipleSentences = /(?:[!?。！？]\s*|\.\s+)[*_`"'“‘([]*\S/u.test(withoutAbbreviationPeriods);
  return !hasFirstPerson && !hasMultipleSentences;
}

function parseImpactNotes(texts: readonly string[]): readonly ImpactNoteObservation[] {
  const observations: ImpactNoteObservation[] = [];

  for (const [textIndex, text] of texts.entries()) {
    const lines = text.replace(/\r/gu, "").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const firstLine = lines[index] ?? "";
      // Only the effect label is bold: the first and third lines carry the same
      // fixed wording in every note, so the single bold span stays the reader's
      // entry point. A bolded first line is the superseded scaffold and is
      // rejected rather than silently accepted.
      const titleMatch = /^> (How Context Tree affected this work|Context Tree 如何影响本次工作)\\$/u.exec(firstLine);
      const currentTitleScaffoldMatch =
        /^> (How Context Tree affected this work|Context Tree 如何影响本次工作)\\?\s*$/u.exec(firstLine);
      const legacyTitleMatch = /^> \*\*(Context Tree impact|Context Tree 影响)(?: · ([^*]+))?\*\*\\?\s*$/u.exec(
        firstLine,
      );
      if (!currentTitleScaffoldMatch && !legacyTitleMatch) continue;

      const language: ImpactNoteLanguage =
        currentTitleScaffoldMatch?.[1] === "Context Tree 如何影响本次工作" ||
        legacyTitleMatch?.[1] === "Context Tree 影响"
          ? "zh"
          : "en";
      const secondLine = lines[index + 1] ?? "";
      const thirdLine = lines[index + 2] ?? "";
      const effectMatch =
        language === "zh"
          ? /^> \*\*([^*]+)\*\*：([^\s].*)\\$/u.exec(secondLine)
          : /^> \*\*([^*]+):\*\* (.+)\\$/u.exec(secondLine);
      const sourcePrefix = language === "zh" ? /^> Context Tree 来源：/u : /^> Context Tree (source|sources): /u;
      const sourcePrefixMatch = sourcePrefix.exec(thirdLine);
      const markdownLinks = [...thirdLine.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/gu)];
      const exactLinks = markdownLinks.filter((match) => parseExactCredentialFreeSourceLink(match[2] ?? "") !== null);
      const expectedEnglishSource = markdownLinks.length === 1 ? "source" : "sources";
      const sourceLabel = language === "zh" ? "Context Tree 来源" : `Context Tree ${expectedEnglishSource}:`;
      const sourceSeparator = language === "zh" ? "：" : " ";
      const expectedSourceLine = `> ${sourceLabel}${sourceSeparator}${markdownLinks.map((match) => match[0]).join(" · ")}`;
      const sourceScaffoldingOk =
        titleMatch !== null &&
        sourcePrefixMatch !== null &&
        (language === "zh" || sourcePrefixMatch[1] === expectedEnglishSource) &&
        markdownLinks.length > 0 &&
        thirdLine === expectedSourceLine;
      const summary = effectMatch?.[2]?.trim() ?? "";

      observations.push({
        atEnd: lines.slice(index + 3).every((line) => line.trim() === ""),
        blankLineBefore: index > 0 && (lines[index - 1] ?? "").trim() === "",
        effectLabel: effectMatch?.[1]?.trim() ?? legacyTitleMatch?.[2]?.trim() ?? "",
        exactLinksOk: exactLinks.length === markdownLinks.length && exactLinks.length > 0,
        language,
        logicalLinesOk: effectMatch !== null && sourcePrefixMatch !== null && !(lines[index + 3] ?? "").startsWith(">"),
        sourceLabels: markdownLinks.map((match) => match[1] ?? ""),
        sourceScaffoldingOk,
        sourceUrls: markdownLinks.map((match) => match[2] ?? ""),
        summary,
        summaryObjectiveOk: isObjectiveImpactSummary(summary),
        textIndex,
      });
    }
  }

  return observations;
}

function visibleUrlsCredentialFree(texts: readonly string[]): boolean {
  const urls = texts
    .flatMap((text) => [...text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>\])]+/giu)].map((match) => match[0] ?? ""))
    .filter(Boolean);

  return urls.every((value) => {
    try {
      const url = new URL(value);
      // SSH commonly carries the transport identity as `git@host`; that
      // username is part of the repository contract, not a credential.
      return url.password === "" && (url.protocol === "ssh:" || url.username === "");
    } catch {
      return false;
    }
  });
}

function sourceAuthorityMatches(
  observation: ImpactNoteObservation | null,
  expectation: ImpactNoteExpectation,
  selectedExactCommit: string | null,
): boolean {
  if (expectation.mode === "absent") return true;
  if (observation === null) return false;

  const expectedRepository = canonicalRepositoryIdentity(expectation.sourceAuthority.repository);
  const expectedCommit = (expectation.sourceAuthority.exactCommit ?? selectedExactCommit)?.toLowerCase() ?? null;
  const allowedPaths = new Set(expectation.sourceAuthority.allowedNodePaths);
  if (expectedRepository === null || expectedCommit === null) return false;

  return observation.sourceUrls.every((value) => {
    const source = parseExactCredentialFreeSourceLink(value);
    return (
      source !== null &&
      source.repositoryIdentity === expectedRepository &&
      source.commit === expectedCommit &&
      allowedPaths.has(source.nodePath)
    );
  });
}

function includesAny(value: string, alternatives: readonly string[]): boolean {
  const normalized = value.toLocaleLowerCase();
  return alternatives.some((alternative) => normalized.includes(alternative.toLocaleLowerCase()));
}

function deriveImpactNoteMetrics(
  texts: readonly string[],
  expectation: ImpactNoteExpectation,
  options: {
    contextDecisionMetadataPresent: boolean;
    selectedExactCommit: string | null;
    visibleOutputKinds?: readonly (ManagedTransport | null)[];
  },
) {
  const observations = parseImpactNotes(texts);
  const observation = observations[0] ?? null;
  const allText = texts.join("\n");
  const metadataFree =
    !options.contextDecisionMetadataPresent &&
    !/contextDecision|["']effect["']\s*:|["']evidence["']\s*:/u.test(allText);
  const atFinalEnd = observation?.atEnd === true && observation.textIndex === texts.length - 1;
  // A blocking question asks the reader to choose; an attribution footnote there
  // competes with the choice instead of serving it.
  const noteOutsideBlockingAsk = observations.every((item) => options.visibleOutputKinds?.[item.textIndex] !== "ask");
  const sourceAuthorityOk = sourceAuthorityMatches(observation, expectation, options.selectedExactCommit);
  const visibleUrlsSafe = visibleUrlsCredentialFree(texts);
  const summaryConceptsOk =
    expectation.mode === "absent" ||
    (expectation.summaryConcepts?.every((alternatives) => includesAny(observation?.summary ?? "", alternatives)) ??
      true);
  const summaryForbiddenOk =
    expectation.mode === "absent" ||
    !(expectation.summaryForbidden?.some((value) => includesAny(observation?.summary ?? "", [value])) ?? false);
  const requiredSourceLabelsOk =
    expectation.mode === "absent" ||
    (expectation.requiredSourceLabels?.every((label) => observation?.sourceLabels.includes(label)) ?? true);
  const sourceCountOk =
    expectation.mode === "absent" ||
    ((observation?.sourceLabels.length ?? 0) >= expectation.sourceCount.min &&
      (observation?.sourceLabels.length ?? 0) <= expectation.sourceCount.max);
  const expectedEffectLabel =
    expectation.mode === "present" ? EFFECT_LABELS[expectation.language][expectation.effect] : null;
  const behaviorOk =
    expectation.mode === "absent"
      ? observations.length === 0 && metadataFree && noteOutsideBlockingAsk
      : observations.length === 1 &&
        observation !== null &&
        atFinalEnd &&
        observation.blankLineBefore &&
        observation.logicalLinesOk &&
        observation.sourceScaffoldingOk &&
        observation.summaryObjectiveOk &&
        observation.exactLinksOk &&
        noteOutsideBlockingAsk &&
        sourceAuthorityOk &&
        observation.language === expectation.language &&
        observation.effectLabel === expectedEffectLabel &&
        sourceCountOk &&
        requiredSourceLabelsOk &&
        summaryConceptsOk &&
        summaryForbiddenOk &&
        metadataFree &&
        visibleUrlsSafe;

  return {
    impactNoteBehaviorOk: behaviorOk,
    impactNoteAtFinalEnd: atFinalEnd,
    impactNoteBlankLineBefore: observation?.blankLineBefore ?? false,
    impactNoteCount: observations.length,
    impactNoteEffect: observation?.effectLabel ?? null,
    impactNoteExactLinksOk: observation?.exactLinksOk ?? false,
    impactNoteLanguage: observation?.language ?? null,
    impactNoteLogicalLinesOk: observation?.logicalLinesOk ?? false,
    impactNoteMetadataFree: metadataFree,
    impactNoteOutsideBlockingAsk: noteOutsideBlockingAsk,
    impactNoteSourceAuthorityOk: sourceAuthorityOk,
    impactNoteSourceCount: observation?.sourceLabels.length ?? 0,
    impactNoteSourceLabels: observation?.sourceLabels ?? [],
    impactNoteSummaryConceptsOk: summaryConceptsOk,
    impactNoteSummaryForbiddenOk: summaryForbiddenOk,
    impactNoteSummaryObjectiveOk: observation?.summaryObjectiveOk ?? false,
    impactNoteVisibleUrlsCredentialFree: visibleUrlsSafe,
  };
}

function argvEquals(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function commandArgv(argv: readonly string[]): readonly string[] {
  return argv[0] === "--json" ? argv.slice(1) : argv;
}

function isHelpArgv(argv: readonly string[]): boolean {
  return argvEquals(commandArgv(argv), HELP_ARGV);
}

function isReadRouteArgv(argv: readonly string[]): boolean {
  const command = commandArgv(argv);
  return command[0] === "context" && command[1] === "route";
}

function isReadActivationArgv(argv: readonly string[]): boolean {
  const command = commandArgv(argv);
  return command[0] === "context" && command[1] === "snapshot";
}

function isLegacyReadActivationArgv(argv: readonly string[]): boolean {
  const command = commandArgv(argv);
  return command[0] === "tree" && command[1] === "read" && !command.includes("--help") && !command.includes("-h");
}

function isTreeTreeArgv(argv: readonly string[]): boolean {
  const command = commandArgv(argv);
  return command[0] === "tree" && command[1] === "tree";
}

function isTreeSelectorArgv(argv: readonly string[]): boolean {
  return isTreeTreeArgv(argv) && !isHelpArgv(argv);
}

function isChatAuthoringArgv(argv: readonly string[]): boolean {
  const command = commandArgv(argv);
  return command[0] === "chat" && (command[1] === "send" || command[1] === "ask");
}

function isChatProgressArgv(argv: readonly string[]): boolean {
  const command = commandArgv(argv);
  return command[0] === "chat" && command[1] === "update";
}

function chatAuthoringKind(argv: readonly string[]): "ask" | "send" | null {
  const command = commandArgv(argv);
  return command[0] === "chat" && (command[1] === "ask" || command[1] === "send") ? command[1] : null;
}

function metadataOptionValues(argv: readonly string[]): readonly string[] {
  const command = commandArgv(argv);
  const values: string[] = [];
  for (let index = 2; index < command.length; index += 1) {
    const arg = command[index] ?? "";
    if (arg === "--metadata" || arg === "-m") {
      const value = command[index + 1];
      if (value !== undefined) values.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--metadata=") || arg.startsWith("-m=")) {
      values.push(arg.slice(arg.indexOf("=") + 1));
    }
  }
  return values;
}

function hasContextDecisionMetadata(argv: readonly string[]): boolean {
  return metadataOptionValues(argv).some((value) => {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) && Object.hasOwn(parsed, "contextDecision");
    } catch {
      return /["']?contextDecision["']?\s*:/u.test(value);
    }
  });
}

function isModelPhase(event: Record<string, unknown>): boolean {
  return event.phase === "model";
}

function eventType(event: Record<string, unknown>): string | null {
  return typeof event.type === "string" ? event.type : null;
}

function containsSkillFileRead(event: unknown): boolean {
  if (!isRecord(event)) return false;
  if (eventType(event) !== "codex_event") return false;

  const nestedEvent = event.event;
  if (!findStringValue(nestedEvent, (value) => value.includes("first-tree-read/SKILL.md"))) {
    return false;
  }

  const serialized = JSON.stringify(nestedEvent) ?? "";
  if (serialized.includes("Available Skills")) return false;
  return /tool|exec|command|cmd|read|cat|sed/iu.test(serialized);
}

function isAssistantMessageRecord(record: Record<string, unknown>): boolean {
  const type = eventType(record);
  const role = typeof record.role === "string" ? record.role : null;

  if (type === "agent_message" || type === "assistant_message") return true;
  if (type === "message" && (role === null || role === "assistant")) return true;
  if (type === "output_text" || type === "response.output_text.done") return true;

  return false;
}

function collectTextValue(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const texts: string[] = [];
    for (const item of value) {
      texts.push(...collectTextValue(item));
    }
    return texts;
  }
  if (!isRecord(value)) return [];

  const texts: string[] = [];
  for (const key of TEXT_KEYS) {
    const item = value[key];
    if (typeof item === "string") {
      texts.push(item);
    } else if (Array.isArray(item)) {
      texts.push(...collectTextValue(item));
    }
  }
  return texts;
}

function collectAssistantText(value: unknown): string[] {
  if (Array.isArray(value)) {
    const texts: string[] = [];
    for (const item of value) {
      texts.push(...collectAssistantText(item));
    }
    return texts;
  }
  if (!isRecord(value)) return [];

  const texts: string[] = [];
  if (isAssistantMessageRecord(value)) {
    texts.push(...collectTextValue(value));
  }

  const item = value.item;
  if (isRecord(item)) {
    texts.push(...collectAssistantText(item));
  }

  const message = value.message;
  if (isRecord(message)) {
    texts.push(...collectAssistantText(message));
  }

  const response = value.response;
  if (isRecord(response) || Array.isArray(response)) {
    texts.push(...collectAssistantText(response));
  }

  const output = value.output;
  if (Array.isArray(output)) {
    texts.push(...collectAssistantText(output));
  }

  return texts;
}

function collectModelOutputText(event: unknown): string[] {
  if (!isRecord(event)) return [];
  if (eventType(event) !== "codex_event") return [];
  return collectAssistantText(event.event);
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function uniqueStrings(values: readonly string[]): string[] {
  const unique: string[] = [];
  for (const value of values) {
    if (!unique.includes(value)) unique.push(value);
  }
  return unique;
}

function expectedFactHits(modelOutputText: string, expectedFacts: readonly string[]): string[] {
  const normalizedOutput = normalizeForMatch(modelOutputText);
  const hits: string[] = [];

  for (const fact of uniqueStrings(expectedFacts)) {
    const normalizedFact = normalizeForMatch(fact);
    const factMatcher = FACT_MATCHERS.find((matcher) => matcher.fact === fact);
    const matchedByConcept = factMatcher?.all.every((pattern) => pattern.test(modelOutputText)) ?? false;
    const matchedByExactNormalized = normalizedFact.length > 0 && normalizedOutput.includes(normalizedFact);
    if (matchedByExactNormalized || matchedByConcept) {
      hits.push(fact);
    }
  }

  return hits;
}

export function deriveMetrics(
  events: readonly unknown[],
  fixtureValidation: FixtureValidation,
  runnerExitCode: number | null,
  expectedFacts: readonly string[],
  impactNoteExpectation: ImpactNoteExpectation = { mode: "absent" },
  managedTransportExpectation: ManagedTransport | null = null,
): EvalMetrics {
  let firstTreeCalls = 0;
  let helpCalls = 0;
  let legacyReadActivationCalls = 0;
  let readActivationCalls = 0;
  let readRouteCalls = 0;
  let skillFileReadObserved = false;
  const authoringCalls: Array<{
    argv: string[];
    body: string;
    contextDecisionMetadataPresent: boolean;
    exitCode: number | null;
  }> = [];
  const progressCalls: Array<{ argv: string[]; body: string; exitCode: number | null }> = [];
  const firstTreeArgv: string[][] = [];
  const firstTreeCommandResults: Array<{ argv: string[]; exitCode: number }> = [];
  const helpExitCodes: number[] = [];
  const modelOutputTexts: string[] = [];
  const readActivationResults: Array<{ exactCommit: string | null; exitCode: number }> = [];
  const readRouteExitCodes: number[] = [];
  const selectorSnapshotResults: Array<{ actualHead: string | null; detachedHead: boolean }> = [];

  for (const event of events) {
    if (containsSkillFileRead(event)) {
      skillFileReadObserved = true;
    }

    modelOutputTexts.push(...uniqueStrings(collectModelOutputText(event)));

    if (!isRecord(event)) continue;
    const type = eventType(event);
    if ((type === "first_tree_call" || type === "first_tree_result") && isModelPhase(event)) {
      const argv = event.argv;
      if (!isStringArray(argv)) continue;

      if (type === "first_tree_call") {
        firstTreeCalls += 1;
        firstTreeArgv.push([...argv]);
        if (isChatAuthoringArgv(argv)) {
          authoringCalls.push({
            argv: [...argv],
            body: typeof event.body === "string" ? event.body : "",
            contextDecisionMetadataPresent: hasContextDecisionMetadata(argv),
            exitCode: null,
          });
        }
        if (isChatProgressArgv(argv)) {
          progressCalls.push({
            argv: [...argv],
            body: typeof event.body === "string" ? event.body : "",
            exitCode: null,
          });
        }
        if (isHelpArgv(argv)) {
          helpCalls += 1;
        }
        if (isReadActivationArgv(argv)) {
          readActivationCalls += 1;
        }
        if (isLegacyReadActivationArgv(argv)) {
          legacyReadActivationCalls += 1;
        }
        if (isReadRouteArgv(argv)) {
          readRouteCalls += 1;
        }
      }

      if (type === "first_tree_result" && typeof event.exitCode === "number") {
        firstTreeCommandResults.push({ argv: [...argv], exitCode: event.exitCode });
        if (isChatAuthoringArgv(argv)) {
          const pendingCall = authoringCalls.find((call) => call.exitCode === null && argvEquals(call.argv, argv));
          if (pendingCall) pendingCall.exitCode = event.exitCode;
        }
        if (isChatProgressArgv(argv)) {
          const pendingCall = progressCalls.find((call) => call.exitCode === null && argvEquals(call.argv, argv));
          if (pendingCall) pendingCall.exitCode = event.exitCode;
        }
        if (isHelpArgv(argv)) {
          helpExitCodes.push(event.exitCode);
        }
        if (isReadRouteArgv(argv)) {
          readRouteExitCodes.push(event.exitCode);
        }
        if (isReadActivationArgv(argv)) {
          readActivationResults.push({
            exactCommit: typeof event.exactCommit === "string" ? event.exactCommit : null,
            exitCode: event.exitCode,
          });
        }
        if (isTreeSelectorArgv(argv) && event.exitCode === 0) {
          selectorSnapshotResults.push({
            actualHead: typeof event.actualHead === "string" ? event.actualHead : null,
            detachedHead: event.detachedHead === true,
          });
        }
      }
    }
  }

  const successfulAuthoringCalls = authoringCalls.filter((call) => call.exitCode === 0);
  const successfulProgressCalls = progressCalls.filter((call) => call.exitCode === 0);
  const authoredOutputTexts = successfulAuthoringCalls.map((call) => call.body);
  const factOutputTexts = authoringCalls.length > 0 ? authoredOutputTexts : modelOutputTexts;
  const visibleOutputTexts =
    authoringCalls.length > 0 || progressCalls.length > 0
      ? [...modelOutputTexts, ...successfulProgressCalls.map((call) => call.body), ...authoredOutputTexts]
      : modelOutputTexts;
  // Index-aligned with `visibleOutputTexts` so the grader can tell which surface
  // a note was found on. A blocking question must stay decision-self-sufficient,
  // so a note delivered in a `chat ask` body fails regardless of its shape.
  const visibleOutputKinds: readonly (ManagedTransport | null)[] =
    authoringCalls.length > 0 || progressCalls.length > 0
      ? [
          ...modelOutputTexts.map(() => null),
          ...successfulProgressCalls.map(() => null),
          ...successfulAuthoringCalls.map((call) => chatAuthoringKind(call.argv)),
        ]
      : modelOutputTexts.map(() => null);
  const contextDecisionMetadataPresent = successfulAuthoringCalls.some((call) => call.contextDecisionMetadataPresent);
  const facts = uniqueStrings(expectedFacts);
  const factHits = expectedFactHits(factOutputTexts.join("\n"), facts);
  const helpSucceeded = firstTreeCommandResults.some((result) => isHelpArgv(result.argv) && result.exitCode === 0);
  const selectionSucceeded = firstTreeCommandResults.some(
    (result) => isTreeSelectorArgv(result.argv) && result.exitCode === 0,
  );
  const readActivationSucceeded =
    readActivationCalls === 1 &&
    readActivationResults.length === 1 &&
    readActivationResults[0]?.exitCode === 0 &&
    readActivationResults[0]?.exactCommit !== null;
  const readRouteSucceeded = readRouteCalls === 1 && readRouteExitCodes.length === 1 && readRouteExitCodes[0] === 0;
  const selectorCalls = firstTreeArgv.filter(isTreeSelectorArgv);
  const byoSelectorsNoPull = selectorCalls.length > 0 && selectorCalls.every((argv) => argv.includes("--no-pull"));
  const readRouteIndex = firstTreeArgv.findIndex(isReadRouteArgv);
  const readActivationIndex = firstTreeArgv.findIndex(isReadActivationArgv);
  const hierarchyHelpIndex = firstTreeArgv.findIndex(isHelpArgv);
  const selectorIndexes = firstTreeArgv
    .map((argv, index) => (isTreeSelectorArgv(argv) ? index : -1))
    .filter((index) => index >= 0);
  const byoReadSequenceOk =
    legacyReadActivationCalls === 0 &&
    readRouteIndex >= 0 &&
    readActivationIndex > readRouteIndex &&
    hierarchyHelpIndex > readActivationIndex &&
    selectorIndexes.length > 0 &&
    selectorIndexes.every((index) => index > hierarchyHelpIndex);
  const exactCommit = readActivationResults.find((result) => result.exitCode === 0)?.exactCommit ?? null;
  const byoSnapshotExactHeadConsistent =
    exactCommit !== null &&
    selectorSnapshotResults.length > 0 &&
    selectorSnapshotResults.length === selectorCalls.length &&
    selectorSnapshotResults.every((result) => result.actualHead === exactCommit);
  const byoSnapshotDetached =
    selectorSnapshotResults.length > 0 &&
    selectorSnapshotResults.length === selectorCalls.length &&
    selectorSnapshotResults.every((result) => result.detachedHead);
  const modelFirstTreeCommandsOk = firstTreeCommandResults.every((result) => result.exitCode === 0);
  const selectedExactCommit = exactCommit ?? selectorSnapshotResults.at(-1)?.actualHead ?? null;
  const finalAuthoringKind = chatAuthoringKind(successfulAuthoringCalls.at(-1)?.argv ?? []);
  const managedFinalTransportOk =
    managedTransportExpectation === null || finalAuthoringKind === managedTransportExpectation;
  const impactNoteMetrics = deriveImpactNoteMetrics(visibleOutputTexts, impactNoteExpectation, {
    contextDecisionMetadataPresent,
    selectedExactCommit,
    visibleOutputKinds,
  });

  return {
    expectedFactHits: factHits,
    expectedFactsObserved: facts.length > 0 && factHits.length === facts.length,
    firstTreeArgv,
    firstTreeCalls,
    firstTreeCommandResults,
    fixtureValidationOk: fixtureValidation.ok,
    helpAttempted: helpCalls > 0,
    helpCalls,
    helpExitCodes,
    helpSucceeded,
    ...impactNoteMetrics,
    byoReadSequenceOk,
    byoSelectorsNoPull,
    byoSnapshotDetached,
    byoSnapshotExactHeadConsistent,
    legacyReadActivationCalls,
    modelFirstTreeCommandsOk,
    managedFinalTransportOk,
    managedFinalTransportKind: finalAuthoringKind,
    managedTransportExpected: managedTransportExpectation,
    readActivationCalls,
    readActivationSucceeded,
    readRouteCalls,
    readRouteSucceeded,
    runnerExitCode,
    selectionSucceeded,
    skillFileReadObserved,
    skillHit: skillFileReadObserved || firstTreeCalls > 0 || firstTreeCommandResults.length > 0,
  };
}

export function casePassed(expectedTrigger: boolean, metrics: EvalMetrics, readMode: ReadMode = "managed"): boolean {
  if (!metrics.fixtureValidationOk) return false;
  if (metrics.runnerExitCode !== 0) return false;

  if (expectedTrigger) {
    const readModePassed =
      readMode === "managed" ||
      (metrics.readRouteSucceeded &&
        metrics.readActivationSucceeded &&
        metrics.byoReadSequenceOk &&
        metrics.byoSelectorsNoPull &&
        metrics.byoSnapshotDetached &&
        metrics.byoSnapshotExactHeadConsistent);
    return (
      metrics.skillFileReadObserved &&
      metrics.expectedFactsObserved &&
      metrics.impactNoteBehaviorOk &&
      metrics.helpSucceeded &&
      metrics.selectionSucceeded &&
      metrics.modelFirstTreeCommandsOk &&
      (readMode === "byo" || metrics.managedFinalTransportOk) &&
      readModePassed
    );
  }

  return (
    !metrics.skillHit &&
    metrics.impactNoteBehaviorOk &&
    metrics.expectedFactHits.length === 0 &&
    metrics.firstTreeCalls === 0 &&
    metrics.firstTreeCommandResults.length === 0 &&
    metrics.modelFirstTreeCommandsOk
  );
}
