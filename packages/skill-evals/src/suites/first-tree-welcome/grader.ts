import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { runCommand } from "../../core/commands.js";
import { findStringValue, isRecord, isStringArray } from "../../core/events.js";
import {
  type ShellConnector,
  shellCommandSegmentsWithConnectors,
  shellWordsWithRedirectsRemoved,
} from "../../core/shell.js";
import type { RunPaths } from "../../core/types.js";
import type { EvalMetrics, FirstTreeWelcomeEvalCase, FixtureValidation, WelcomeExpectedAction } from "./types.js";

const TEXT_KEYS = ["content", "message", "output_text", "text"];

function eventType(event: Record<string, unknown>): string | null {
  return typeof event.type === "string" ? event.type : null;
}

function isModelPhase(event: Record<string, unknown>): boolean {
  return event.phase === "model";
}

function containsSkillFileRead(event: unknown): boolean {
  if (!isRecord(event)) return false;
  if (eventType(event) !== "codex_event") return false;

  const nestedEvent = event.event;
  if (!findStringValue(nestedEvent, (value) => value.includes("first-tree-welcome/SKILL.md"))) {
    return false;
  }

  const serialized = JSON.stringify(nestedEvent) ?? "";
  if (serialized.includes("Available Skills")) return false;
  return /tool|exec|command|cmd|read|cat|sed/iu.test(serialized);
}

function containsPathAccess(event: unknown, patterns: readonly string[]): boolean {
  if (!isRecord(event)) return false;
  if (eventType(event) !== "codex_event") return false;
  const serialized = JSON.stringify(event.event) ?? "";
  if (!/tool|exec|command|cmd|read|cat|sed|rg|ls/iu.test(serialized)) return false;
  return patterns.some((pattern) => serialized.includes(pattern));
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

type CommandInvocation = { command: string; cwd: string | null };

function collectCommandInvocations(value: unknown, inheritedCwd: string | null = null): CommandInvocation[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectCommandInvocations(item, inheritedCwd));
  }
  if (!isRecord(value)) return [];

  const cwd =
    typeof value.workdir === "string" ? value.workdir : typeof value.cwd === "string" ? value.cwd : inheritedCwd;
  const invocations: CommandInvocation[] = [];
  if (typeof value.command === "string") invocations.push({ command: value.command, cwd });
  if (typeof value.cmd === "string") invocations.push({ command: value.cmd, cwd });

  for (const [key, item] of Object.entries(value)) {
    if (["command", "cmd", "cwd", "workdir"].includes(key)) continue;
    if (isRecord(item) || Array.isArray(item)) {
      invocations.push(...collectCommandInvocations(item, cwd));
    }
  }
  return invocations;
}

function collectCommandStrings(value: unknown): string[] {
  return collectCommandInvocations(value).map(({ command }) => command);
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  const normalizedHaystack = normalizeForMatch(haystack);
  for (const needle of needles) {
    const normalizedNeedle = normalizeForMatch(needle);
    if (normalizedNeedle.length > 0 && normalizedHaystack.includes(normalizedNeedle)) {
      return true;
    }
  }
  return false;
}

function containsAll(haystack: string, needles: readonly string[]): boolean {
  const normalizedHaystack = normalizeForMatch(haystack);
  return needles.every((needle) => {
    const normalizedNeedle = normalizeForMatch(needle);
    return normalizedNeedle.length > 0 && normalizedHaystack.includes(normalizedNeedle);
  });
}

function offersBothRepoEntryChoices(text: string): boolean {
  const localMatch = text.match(
    /local project folder path|local clone path|local repository path|local repo path|本地(?:项目文件夹|项目|仓库|克隆)?路径/iu,
  );
  const urlMatch = text.match(
    /git repository url|github repo(?:sitory)? url|github url|gitlab repo(?:sitory)? url|gitlab url|仓库\s*url/iu,
  );
  return localMatch?.index !== undefined && urlMatch?.index !== undefined && localMatch.index < urlMatch.index;
}

function countMatches(haystack: string, needles: readonly string[]): number {
  const normalizedHaystack = normalizeForMatch(haystack);
  let count = 0;
  for (const needle of needles) {
    const normalizedNeedle = normalizeForMatch(needle);
    if (normalizedNeedle.length > 0 && normalizedHaystack.includes(normalizedNeedle)) {
      count += 1;
    }
  }
  return count;
}

function collectChatText(argv: readonly string[]): string {
  if (argv[0] !== "chat") return "";
  return argv.slice(2).join(" ");
}

type ParsedChatOptions = {
  count: number;
  texts: readonly string[];
};

function collectOptionText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(collectOptionText).filter(Boolean).join(" ");
  }
  if (!isRecord(value)) return "";

  const chunks: string[] = [];
  for (const key of ["label", "description", "preview"] as const) {
    const item = value[key];
    if (typeof item === "string") chunks.push(item);
  }
  return chunks.join(" ");
}

function parseOptionsFromArgv(argv: readonly string[]): ParsedChatOptions | null {
  const optionIndex = argv.indexOf("--options");
  if (optionIndex < 0) return null;
  const raw = argv[optionIndex + 1];
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return {
        count: parsed.length,
        texts: parsed.map(collectOptionText).filter(Boolean),
      };
    }
    if (isRecord(parsed) && Array.isArray(parsed.options)) {
      return {
        count: parsed.options.length,
        texts: parsed.options.map(collectOptionText).filter(Boolean),
      };
    }
    return null;
  } catch {
    return null;
  }
}

function countTaskOptionLines(text: string): number | null {
  const lines = text.split("\n");
  const optionLines = lines.filter((line) => {
    const trimmed = line.trim();
    if (!/^(-|\*|\d+[.)])\s+/u.test(trimmed)) return false;
    return /checkout|session|map|architecture|test|flow|task|route/iu.test(trimmed);
  });
  return optionLines.length > 0 ? optionLines.length : null;
}

function withoutNegatedSetupLanguage(text: string): string {
  return text
    .replace(/(?:不先要求|不需要|无需|不用|不要先)\s*安装\s*github app/giu, "")
    .replace(/\b(?:without|no need to|do not|don't)\s+(?:install|authorize)[^.;\n]*github app\b/giu, "")
    .replace(/\bwithout\s+(?:selecting|choosing|connecting)\s+(?:a\s+)?(?:repo|repository)\b/giu, "")
    .replace(/\b(?:do not|don't|not)\s+(?:select|choose|connect)\s+(?:a\s+)?(?:repo|repository)\b/giu, "");
}

function containsSetupTaskLanguage(text: string): boolean {
  return /install|github app|create.{0,30}(context\s+)?tree|seed.{0,20}tree|tree.{0,20}setup|setup.{0,20}tree|select.{0,20}repo|connect.{0,20}repo|authori[sz]e|authorization|安装.{0,20}github app|授权/iu.test(
    withoutNegatedSetupLanguage(text),
  );
}

function containsTreeSetupLanguage(text: string): boolean {
  return /create.{0,30}(context\s+)?tree|bind.{0,30}(context\s+)?tree|seed.{0,20}tree|tree.{0,20}setup|setup.{0,20}tree|context tree.{0,40}(setup|set up|create|bind|seed)/iu.test(
    withoutNegatedSetupLanguage(text),
  );
}

function containsRepoSelectionLanguage(text: string): boolean {
  return /\b(select|choose|connect)\b.{0,30}\b(repo|repository)\b|repo selection|repository selection/iu.test(
    withoutNegatedSetupLanguage(text),
  );
}

function containsAdminSetupAction(text: string): boolean {
  const checkedText = withoutNegatedSetupLanguage(text)
    .replace(/\b(?:an?\s+)?admin\s+(?:finishes|handles|owns|will finish|can finish)\s+(?:team\s+)?setup\b/giu, "")
    .replace(/\b(?:team\s+)?setup\s+(?:is|stays|remains)\s+(?:with|for)\s+(?:an?\s+)?admin\b/giu, "");
  return /(?:ask|tell|have|route|send).{0,80}(admin|owner).{0,80}(setup|set up|install|authori[sz]e|github app|create|bind|seed)|\b(admin|owner)\b.{0,40}(needs?|must|should|has to).{0,60}(setup|set up|install|authori[sz]e|github app|create|bind|seed)|\b(install|authori[sz]e).{0,40}github app\b/iu.test(
    checkedText,
  );
}

function claimsRepoEvidence(text: string): boolean {
  const withoutFailure = text.replace(
    /read failure|failed to read|can't read|cannot read|unable to read|auth(?:entication|orization)? failure|permission denied/giu,
    "",
  );
  return /\b(i (read|found|noticed|inspected|saw)|repo shows|repository shows|readme|src\/|checkout|session|todo)\b/iu.test(
    withoutFailure,
  );
}

function claimsTreeReady(text: string): boolean {
  const withoutNegation = text
    .replace(/without assuming (the )?(context )?tree readiness/giu, "")
    .replace(/do not assume (the )?(context )?tree (is )?ready/giu, "");
  return /tree is ready|context tree is ready|populated context tree|shared memory is ready|tree already exists|tree has already been set up/iu.test(
    withoutNegation,
  );
}

function isInputCollectionOption(text: string): boolean {
  if (
    !/local project folder path|local clone path|local path|clone path|github repo url|github url|repo url|repository url|project entry|项目入口|本地路径|仓库\s*url|github\s*仓库/iu.test(
      text,
    )
  ) {
    return false;
  }
  return !containsSetupTaskLanguage(text);
}

function optionLooksLikeTask(text: string, taskOptionHints: readonly string[]): boolean {
  if (isInputCollectionOption(text)) return false;
  if (countMatches(text, taskOptionHints) > 0) return true;
  if (
    /checkout|session|map|architecture|test|flow|task|route|trace|fix|debug|implement|review|audit|write|update|compare|investigate|verify|reliability|todo/iu.test(
      text,
    )
  ) {
    return true;
  }
  return containsSetupTaskLanguage(text);
}

function optionLineTexts(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(-|\*|\d+[.)])\s+/u.test(line));
}

function recommendedTaskTexts(text: string, taskOptionHints: readonly string[]): string[] {
  return text
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => {
      const recommendationIntro =
        /\b(?:i recommend|recommended task|recommend starting|my recommendation)\b|^start with\b|我建议|建议先|^先做|^先从/iu.test(
          paragraph,
        );
      const namedChoiceIntro =
        /^choose\s+[*_`]*(?!(?:one|a|an|between|from|either)\b)[\p{L}\p{N}]/iu.test(paragraph) ||
        /^选择\s*[*_`]*(?!(?:一个|一项|其中))[\p{L}\p{N}]/iu.test(paragraph);
      return (recommendationIntro || namedChoiceIntro) && optionLooksLikeTask(paragraph, taskOptionHints);
    });
}

function setupTaskOptionObserved(chatOptionTexts: readonly string[], combinedText: string): boolean {
  return (
    chatOptionTexts.some((text) => containsSetupTaskLanguage(text)) ||
    optionLineTexts(combinedText).some((line) => containsSetupTaskLanguage(line))
  );
}

function containsPrematurePrSetup(text: string): boolean {
  return /would you like.{0,40}(?:pr|pull request|merge request|github app)|(?:create|open).{0,30}(?:pr|pull request|merge request)|install.{0,30}github app|register.{0,30}(?:team )?repo/iu.test(
    text,
  );
}

function containsPullRequestOption(text: string): boolean {
  return /\b(?:pr|mr)\b|pull request|merge request/iu.test(text);
}

function bestTaskOptionCount(
  chatOptionTexts: readonly string[],
  combinedText: string,
  taskOptionHints: readonly string[],
): number | null {
  if (chatOptionTexts.length > 0) {
    const taskOptions = chatOptionTexts.filter((text) => optionLooksLikeTask(text, taskOptionHints));
    return taskOptions.length > 0 ? taskOptions.length : null;
  }
  return countTaskOptionLines(combinedText);
}

function microtaskMenuObserved(metrics: EvalMetrics): boolean {
  const deliveryObserved =
    (metrics.microtaskOptionCount === 1 && metrics.chatAskCount === 0 && metrics.chatSendCount === 1) ||
    (metrics.microtaskOptionCount === 2 && metrics.chatAskCount === 1 && metrics.chatSendCount === 0);
  return (
    metrics.boundedReadObserved &&
    metrics.workingStatusObserved &&
    metrics.projectReceiptObserved &&
    metrics.taskOptionsObserved &&
    metrics.microtaskOptionCount >= 1 &&
    metrics.microtaskOptionCount <= 2 &&
    metrics.readOnlyOptionCount >= 1 &&
    metrics.mutationOptionCount === metrics.qualifiedMutationOptionCount &&
    metrics.freeInputObserved &&
    !metrics.chatMultiSelectObserved &&
    !metrics.timeEstimateObserved &&
    !metrics.capabilitySetupOptionObserved &&
    metrics.taskChatCreateCount === 0 &&
    deliveryObserved
  );
}

function isReadOnlyOption(text: string): boolean {
  if (isMutationOption(text) || containsPullRequestOption(text)) return false;
  return /read[- ]?only|\b(?:analy[sz]e|assess|audit|check|compare|explain|inspect|investigate|map|review|test|trace|verify)\b|只读|分析|评估|审计|检查|比较|解释|查看|调查|梳理|映射|测试|追踪|验证/iu.test(
    text,
  );
}

function isMutationOption(text: string): boolean {
  return /\b(add|change|edit|fix|implement|remove|rename|update|write)\b|新增|修改|修复|实现|删除|重命名|更新/iu.test(
    text,
  );
}

function isQualifiedMutationOption(text: string): boolean {
  const hasTarget = /(?:^|\s)(?:[\w.-]+\/)+[\w.-]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|rb|java)\b/u.test(text);
  const hasFocusedCheck =
    /focused (?:check|test|verification)|run .{0,80}(?:test|check|lint)|passing (?:test|check)|聚焦(?:检查|测试|验证)/iu.test(
      text,
    );
  return isMutationOption(text) && hasTarget && hasFocusedCheck;
}

function hasQualifiedMutationTask(text: string, taskOptionHints: readonly string[]): boolean {
  const optionLines = optionLineTexts(text);
  const taskUnits = optionLines.length > 0 ? optionLines : recommendedTaskTexts(text, taskOptionHints);
  return taskUnits.some(isQualifiedMutationOption);
}

function hasTimeEstimate(text: string): boolean {
  return /\b(?:about|roughly|around|under|within)?\s*\d+(?:\s*[–—-]\s*\d+)?\s*(?:minutes?|mins?|hours?|hrs?)\b|约\s*\d+(?:\s*[–—-]\s*\d+)?\s*(?:分钟|小时)/iu.test(
    text,
  );
}

function acceptsFreeInput(text: string): boolean {
  return /type (?:a )?(?:different|another|your own|free[- ]?text)|free[- ]?text|different microtask|another microtask|用文字输入|自由输入|其他微任务/iu.test(
    text,
  );
}

function hasConcreteProjectSurface(text: string): boolean {
  return /`[^`]+`|(?:[\w.-]+\/)+[\w.-]+|\b(?:readme(?:\.\w+)?|manifest|package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|build\.gradle|makefile|[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|rb|java))\b/iu.test(
    text,
  );
}

function hasNamedStartingPoint(text: string): boolean {
  if (hasConcreteProjectSurface(text)) return true;
  if (
    /\b(?!(?:a|an|the|this|that|its|our|your|project|current|existing|main|primary|relevant)\b)[a-z][\w.-]*(?:\s+(?!(?:a|an|the|this|that|its|our|your|project|current|existing|main|primary|relevant)\b)[a-z][\w.-]*){0,2}\s+(?:entry point|entry|boundary|module|path|route|flow|branch|test|todo|service|component|package|handler|subsystem)\b/iu.test(
      text,
    )
  ) {
    return true;
  }

  const chineseNamedSurface = text.match(
    /([\p{Script=Han}a-z0-9_.-]{1,24}?)(?:模块|服务|组件|包|处理器|子系统|入口|边界|路由|流程|分支|测试|待办|起点)/iu,
  )?.[1];
  if (!chineseNamedSurface) return false;

  let withoutGenericSuffix = chineseNamedSurface;
  const genericSuffix =
    /(?:(?:这个|当前|该|本|此)?项目(?:中|里|里面)?的?|(?:我们|你们)(?:的)?|(?:这个|当前|一个|该|其|本|此)(?:的)?)$/u;
  for (let segmentIndex = 0; segmentIndex < 24; segmentIndex += 1) {
    const stripped = withoutGenericSuffix.replace(genericSuffix, "");
    if (stripped === withoutGenericSuffix) break;
    withoutGenericSuffix = stripped;
  }
  const withoutConnector = withoutGenericSuffix.replace(
    /^(?:(?:我们|你们|大家)(?:可以|能够|应该|需要)?|(?:可以|能够|应该|需要|建议))(?:先|就)?(?:从|由)?/u,
    "",
  );
  return withoutConnector.length > 0;
}

function hasTwoSentenceReceipt(text: string): boolean {
  const beforeChoice =
    text
      .split(
        /\b(?:choose|pick|select|reply with|i recommend|my recommendation)\b|\n\s*\n\s*start with\b|\n\s*[-*]\s+|请选择|选择(?:一个|其中)|回复(?:这个|该)|我建议|建议先/iu,
      )[0]
      ?.trim() ?? "";
  const sentences = beforeChoice
    .split(/(?<=[.!?])\s+|(?<=[。！？])\s*/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const [readSentence = "", startSentence = ""] = sentences;
  return (
    sentences.length === 2 &&
    /read|found|observed|inspected|读到|看到|发现/iu.test(readSentence) &&
    hasConcreteProjectSurface(readSentence) &&
    hasNamedStartingPoint(startSentence)
  );
}

function countBridgeQuestions(text: string): number {
  const questionMarks = text.match(/[?？]/gu)?.length ?? 0;
  if (questionMarks > 0) return questionMarks;
  return text
    .split("\n")
    .filter((line) => /\b(?:would you like|do you want|should i|shall i|want me to)\b|要我|是否要|要不要/iu.test(line))
    .length;
}

function bridgeQuestions(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .filter((line) => /[?？]/u.test(line))
    .map((line) => {
      const questionStart = line.match(
        /\b(?:would you like|do you want|should i|shall i|want me to)\b|要我|是否要|要不要/iu,
      );
      return questionStart?.index === undefined ? line : line.slice(questionStart.index);
    });
}

function matchesExpectedBridge(evalCase: FirstTreeWelcomeEvalCase, text: string): boolean {
  const questions = bridgeQuestions(text);
  const questionText = questions.join("\n");

  if (evalCase.expected.bridgeKind !== "pull_request") {
    const requiredHints = evalCase.expected.bridgeRequiredHints ?? [];
    const forbiddenHints = evalCase.expected.bridgeForbiddenHints ?? [];
    if (requiredHints.length === 0 && forbiddenHints.length === 0) return true;
    return (
      questions.length > 0 && containsAll(questionText, requiredHints) && !containsAny(questionText, forbiddenHints)
    );
  }

  const asksForPullRequestConsent = questions.some((question) =>
    /\b(?:would you like|do you want|should i|shall i|want me to)\b.{0,100}\b(?:create|open)\b.{0,40}\b(?:pr|pull request|merge request)\b|\b(?:create|open)\b.{0,40}\b(?:pr|pull request|merge request)\b.{0,100}[?？]/iu.test(
      question,
    ),
  );
  const mentionsPrematureSetup =
    /github app|context tree|register.{0,30}(?:team )?(?:repo|repository)|install.{0,30}(?:app|integration)|team repository/iu.test(
      text,
    );
  return asksForPullRequestConsent && !mentionsPrematureSetup;
}

function hasReviewableResult(text: string): boolean {
  const numberedSteps = text
    .split("\n")
    .filter(
      (line) =>
        /^\s*\d+[.)]\s+/u.test(line) && /(?:[\w.-]+\/)+[\w.-]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs)\b/u.test(line),
    );
  if (numberedSteps.length >= 5 && numberedSteps.length <= 8) return true;

  const judgmentWithEvidence =
    /\b(?:judgment|finding|conclusion|结论|判断)\b/iu.test(text) &&
    /(?:[\w.-]+\/)+[\w.-]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs)\b|\bline\s+\d+\b|:\d+\b/u.test(text);
  const diffWithCheck =
    /\b(?:diff|changed|修改)\b/iu.test(text) &&
    /\b(?:test|check|lint|verification)\b.{0,80}\b(?:pass|passed|green|exit\s*0)\b|测试.{0,40}通过/iu.test(text);
  return judgmentWithEvidence || diffWithCheck;
}

type SourceRepoCwdScope = "descendant" | "outside" | "root";

function sourceRepoCwdScope(cwd: string | null, workspacePath: string): SourceRepoCwdScope {
  if (cwd === null) return "outside";
  const lexicalSourceRepoPath = resolve(workspacePath, "source-repo");
  const lexicalCwd = resolve(workspacePath, cwd);
  const sourceRepoPath = existsSync(lexicalSourceRepoPath)
    ? realpathSync(lexicalSourceRepoPath)
    : lexicalSourceRepoPath;
  const resolvedCwd = existsSync(lexicalCwd) ? realpathSync(lexicalCwd) : lexicalCwd;
  if (resolvedCwd === sourceRepoPath) return "root";
  return resolvedCwd.startsWith(`${sourceRepoPath}${sep}`) ? "descendant" : "outside";
}

function isDirectFileReference(operand: string, cwd: string): boolean {
  if (operand.endsWith("/")) return false;
  const candidate = resolve(cwd, operand);
  try {
    return statSync(candidate).isFile();
  } catch {
    // Parser-only eval events may omit the fixture path. Fall back to path
    // shape while live runs use the real file type above.
  }
  const basename = operand.replace(/\/$/u, "").split("/").at(-1) ?? "";
  const knownExtensionlessFile =
    /^(?:README|LICENSE|NOTICE|CHANGELOG|CONTRIBUTING|SECURITY|CODEOWNERS|Makefile|Dockerfile)(?:[-_][A-Za-z0-9-]+)?$/iu.test(
      basename,
    );
  const knownFileExtension =
    /\.(?:[cm]?[jt]sx?|astro|bash|c|cc|conf|config|cpp|cs|css|env|fish|go|gql|graphql|h|hpp|html?|ini|java|jsonc?|kt|kts|less|lock|mdx?|php|proto|ps1|py|rb|rs|sass|scss|sh|sql|svelte|toml|tsx?|txt|vue|ya?ml|zsh)$/iu.test(
      basename,
    );
  return (
    basename !== "." && basename !== ".." && !basename.startsWith(".") && (knownExtensionlessFile || knownFileExtension)
  );
}

const RG_LONG_VALUE_OPTIONS = new Set([
  "--after-context",
  "--before-context",
  "--color",
  "--colors",
  "--context",
  "--context-separator",
  "--dfa-size-limit",
  "--encoding",
  "--engine",
  "--file",
  "--field-context-separator",
  "--field-match-separator",
  "--glob",
  "--hostname-bin",
  "--hyperlink-format",
  "--iglob",
  "--ignore-file",
  "--max-columns",
  "--max-count",
  "--max-depth",
  "--max-filesize",
  "--path-separator",
  "--pre",
  "--pre-glob",
  "--regexp",
  "--regex-size-limit",
  "--replace",
  "--sort",
  "--sortr",
  "--threads",
  "--type",
  "--type-add",
  "--type-clear",
  "--type-not",
]);
const RG_PATTERN_LONG_OPTIONS = new Set(["--regexp", "--file"]);
const RG_SHORT_VALUE_OPTIONS = new Set(["A", "B", "C", "E", "M", "T", "d", "e", "f", "g", "j", "m", "r", "t"]);
const RG_PATTERN_SHORT_OPTIONS = new Set(["e", "f"]);

type RgOptionEffect = {
  consumesNext: boolean;
  filesMode: boolean;
  informational: boolean;
  suppliesPattern: boolean;
};

function rgOptionEffect(word: string): RgOptionEffect | null {
  if (word.startsWith("--")) {
    const equalsIndex = word.indexOf("=");
    const name = equalsIndex < 0 ? word : word.slice(0, equalsIndex);
    if (["--help", "--version", "--type-list", "--pcre2-version"].includes(name)) {
      return { consumesNext: false, filesMode: false, informational: true, suppliesPattern: false };
    }
    if (name === "--generate") {
      return {
        consumesNext: equalsIndex < 0,
        filesMode: false,
        informational: true,
        suppliesPattern: false,
      };
    }
    if (name === "--files") {
      return { consumesNext: false, filesMode: true, informational: false, suppliesPattern: false };
    }
    if (RG_LONG_VALUE_OPTIONS.has(name)) {
      return {
        consumesNext: equalsIndex < 0,
        filesMode: false,
        informational: false,
        suppliesPattern: RG_PATTERN_LONG_OPTIONS.has(name),
      };
    }
    return { consumesNext: false, filesMode: false, informational: false, suppliesPattern: false };
  }
  if (!/^-[^-]/u.test(word)) return null;

  const cluster = word.slice(1);
  let informational = false;
  for (let index = 0; index < cluster.length; index += 1) {
    const option = cluster[index] ?? "";
    if (RG_SHORT_VALUE_OPTIONS.has(option)) {
      return {
        consumesNext: index === cluster.length - 1,
        filesMode: false,
        informational,
        suppliesPattern: RG_PATTERN_SHORT_OPTIONS.has(option),
      };
    }
    if (option === "h" || option === "V") informational = true;
  }
  return { consumesNext: false, filesMode: false, informational, suppliesPattern: false };
}

type RgArguments = { filesMode: boolean; informational: boolean; pathOperands: string[] };

function parseRgArguments(words: readonly string[]): RgArguments {
  const positionals: string[] = [];
  let filesMode = false;
  let optionsEnded = false;
  let patternSupplied = false;

  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (!optionsEnded && word === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded) {
      const effect = rgOptionEffect(word);
      if (effect !== null) {
        if (effect.informational) return { filesMode, informational: true, pathOperands: [] };
        if (effect.filesMode) filesMode = true;
        if (effect.suppliesPattern) patternSupplied = true;
        if (effect.consumesNext) index += 1;
        continue;
      }
    }
    positionals.push(word);
  }
  return {
    filesMode,
    informational: false,
    pathOperands: filesMode || patternSupplied ? positionals : positionals.slice(1),
  };
}

function commandUsesInformationalMode(program: string, words: readonly string[]): boolean {
  if (program === "rg") return parseRgArguments(words).informational;
  for (const word of words.slice(1)) {
    if (word === "--") return false;
    if (word === "--help" || word === "--version") return true;
  }
  return false;
}

function shellProgram(word: string | undefined): string {
  return (word ?? "").split("/").at(-1) ?? "";
}

function isShellAssignment(word: string | undefined): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word ?? "");
}

type EffectiveShellCommand = {
  inputFileRedirected: boolean;
  shellBuiltinAllowed: boolean;
  words: readonly string[];
};

function effectiveShellCommand(segment: string): EffectiveShellCommand {
  const shellCommand = shellWordsWithRedirectsRemoved(segment);
  const words = shellCommand.words;
  let index = 0;
  let shellBuiltinAllowed = true;
  while (isShellAssignment(words[index])) index += 1;

  while (index < words.length) {
    const prefixIndex = index;
    const program = shellProgram(words[index]);
    if (program === "command") {
      index += 1;
      while (index < words.length) {
        const option = words[index] ?? "";
        if (option === "--") {
          index += 1;
          break;
        }
        if (/^-[p]+$/u.test(option)) {
          index += 1;
          continue;
        }
        if (/^-[p]*[vV]/u.test(option)) {
          return { ...shellCommand, shellBuiltinAllowed, words: words.slice(prefixIndex) };
        }
        break;
      }
      continue;
    }
    if (program === "env") {
      shellBuiltinAllowed = false;
      index += 1;
      while (index < words.length) {
        const option = words[index] ?? "";
        if (isShellAssignment(option)) {
          index += 1;
          continue;
        }
        if (option === "--") {
          index += 1;
          break;
        }
        if (option === "--help" || option === "--version") {
          return { ...shellCommand, shellBuiltinAllowed, words: words.slice(prefixIndex) };
        }
        if (["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"].includes(option)) {
          index += 1;
          continue;
        }
        if (/^-(?:u|P).+/u.test(option) || /^--unset=/u.test(option)) {
          index += 1;
          continue;
        }
        if (["-u", "-P", "--unset"].includes(option)) {
          index += 2;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  return { ...shellCommand, shellBuiltinAllowed, words: words.slice(index) };
}

function shellCdOperand(command: EffectiveShellCommand): string | null {
  if (!command.shellBuiltinAllowed || shellProgram(command.words[0]) !== "cd") return null;
  const operandIndex = command.words[1] === "--" ? 2 : 1;
  return command.words[operandIndex] ?? null;
}

function segmentUsesBroadRepoScan(
  segment: string,
  command: EffectiveShellCommand,
  cwdScope: SourceRepoCwdScope,
  cwd: string,
): boolean {
  const words = command.words;
  const program = shellProgram(words[0]);
  if (commandUsesInformationalMode(program, words)) return false;
  const cwdIsSourceRepo = cwdScope !== "outside";
  const relativeRootOperand = words.some((word) => word === "." || word === "./");
  const recursiveLs = program === "ls" && words.some((word) => /^-[A-Za-z]*R[A-Za-z]*$/u.test(word));
  const rgArguments = program === "rg" ? parseRgArguments(words) : null;
  const relativeRecursiveScan =
    cwdIsSourceRepo &&
    (program === "tree" ||
      recursiveLs ||
      (program === "rg" &&
        ((rgArguments?.pathOperands.length === 0 && (rgArguments.filesMode || !command.inputFileRedirected)) ||
          rgArguments?.pathOperands.some((operand) => !isDirectFileReference(operand, cwd)))));
  if (relativeRecursiveScan) return true;

  const rootFind = /\bfind\s+(?:\.\/)?source-repo\b/iu.test(segment);
  const relativeFind = cwdIsSourceRepo && program === "find";
  const rootRelativeFind = cwdScope === "root" && relativeRootOperand;
  const allowedFirstLevelFind =
    (rootFind || rootRelativeFind) && /-maxdepth\s+1\b/iu.test(segment) && !/source-repo\/src\b/iu.test(segment);
  const recursiveSearch =
    /\btree\s+(?:\.\/)?source-repo\b|\brg\s+--files\b.{0,120}\bsource-repo\b|\bls\s+-[A-Za-z]*R[A-Za-z]*\b.{0,120}\bsource-repo\b|\brg\b.{0,160}\s(?:\.\/)?source-repo(?:\s|$|--glob)/iu.test(
      segment,
    );
  return ((rootFind || relativeFind) && !allowedFirstLevelFind) || recursiveSearch;
}

type ShellExitStatus = "failure" | "success";
type ShellState = { cwd: string; status: ShellExitStatus; subshellCwds: readonly string[] };

function dedupeShellStates(states: readonly ShellState[]): ShellState[] {
  const unique = new Map<string, ShellState>();
  for (const state of states) {
    unique.set(`${state.cwd}\0${state.status}\0${state.subshellCwds.join("\0")}`, state);
  }
  return [...unique.values()];
}

function executesAfter(connector: ShellConnector | null, status: ShellExitStatus): boolean {
  if (connector === "&&") return status === "success";
  if (connector === "||") return status === "failure";
  return true;
}

function applySubshellClosures(state: ShellState, segmentText: string): ShellState {
  const subshellCwds = [...state.subshellCwds];
  let cwd = state.cwd;
  let remainingText = segmentText.trimEnd();
  while (subshellCwds.length > 0 && remainingText.endsWith(")") && !remainingText.endsWith("\\)")) {
    cwd = subshellCwds.pop() ?? cwd;
    remainingText = remainingText.slice(0, -1).trimEnd();
  }
  return { ...state, cwd, subshellCwds };
}

function segmentOutcomeStates(state: ShellState, segmentText: string, command: EffectiveShellCommand): ShellState[] {
  const cdOperand = shellCdOperand(command);
  if (cdOperand !== null) {
    const nextCwd = resolve(state.cwd, cdOperand);
    const success = applySubshellClosures({ ...state, cwd: nextCwd, status: "success" }, segmentText);
    if (existsSync(nextCwd)) return [success];
    return [success, applySubshellClosures({ ...state, status: "failure" }, segmentText)];
  }

  const program = shellProgram(command.words[0]);
  if (program === "true") {
    return [applySubshellClosures({ ...state, status: "success" }, segmentText)];
  }
  if (program === "false") {
    return [applySubshellClosures({ ...state, status: "failure" }, segmentText)];
  }
  return [
    applySubshellClosures({ ...state, status: "success" }, segmentText),
    applySubshellClosures({ ...state, status: "failure" }, segmentText),
  ];
}

function commandUsesBroadRepoScan(command: string, cwd: string | null, workspacePath: string): boolean {
  let states: ShellState[] = [{ cwd: resolve(workspacePath, cwd ?? "."), status: "success", subshellCwds: [] }];

  for (const segment of shellCommandSegmentsWithConnectors(command)) {
    const nextStates: ShellState[] = [];
    for (const state of states) {
      if (!executesAfter(segment.connectorBefore, state.status)) {
        nextStates.push(applySubshellClosures(state, segment.text));
        continue;
      }

      let segmentText = segment.text.trim();
      const subshellCwds = [...state.subshellCwds];
      while (segmentText.startsWith("(")) {
        subshellCwds.push(state.cwd);
        segmentText = segmentText.slice(1).trimStart();
      }
      const enteredState = { ...state, subshellCwds };
      let commandText = segmentText.trimEnd();
      let remainingClosures = enteredState.subshellCwds.length;
      while (remainingClosures > 0 && commandText.endsWith(")") && !commandText.endsWith("\\)")) {
        commandText = commandText.slice(0, -1).trimEnd();
        remainingClosures -= 1;
      }
      const effectiveCommand = effectiveShellCommand(commandText);
      if (
        segmentUsesBroadRepoScan(
          commandText,
          effectiveCommand,
          sourceRepoCwdScope(enteredState.cwd, workspacePath),
          enteredState.cwd,
        )
      ) {
        return true;
      }
      nextStates.push(...segmentOutcomeStates(enteredState, segmentText, effectiveCommand));
    }
    states = dedupeShellStates(nextStates);
  }
  return false;
}

function treeStatus(paths: RunPaths): string {
  const contextTreePath = join(paths.workspacePath, "context-tree");
  if (!existsSync(contextTreePath)) return "";
  const result = runCommand("git", ["status", "--porcelain"], contextTreePath);
  if (result.exitCode !== 0) return result.stderr || result.stdout;
  return result.stdout;
}

function gitHead(repoPath: string): string | null {
  const result = runCommand("git", ["rev-parse", "HEAD"], repoPath);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

function repoChanged(paths: RunPaths, baselineHead: string | null): boolean {
  const sourceRepoPath = join(paths.workspacePath, "source-repo");
  if (baselineHead === null) return existsSync(sourceRepoPath);
  if (!existsSync(sourceRepoPath)) return true;

  const status = runCommand("git", ["status", "--porcelain"], sourceRepoPath);
  if (status.exitCode !== 0) return true;
  if (status.stdout.trim().length > 0) return true;
  return gitHead(sourceRepoPath) !== baselineHead;
}

function treeChanged(paths: RunPaths, baselineHead: string | null): boolean {
  const contextTreePath = join(paths.workspacePath, "context-tree");
  if (baselineHead === null) return existsSync(contextTreePath);
  if (!existsSync(contextTreePath)) return true;

  const status = runCommand("git", ["status", "--porcelain"], contextTreePath);
  if (status.exitCode !== 0) return true;
  if (status.stdout.trim().length > 0) return true;
  return gitHead(contextTreePath) !== baselineHead;
}

function baselineHeads(events: readonly unknown[]): { contextTreeHead: string | null; sourceRepoHead: string | null } {
  let contextTreeHead: string | null = null;
  let sourceRepoHead: string | null = null;
  for (const event of events) {
    if (!isRecord(event) || eventType(event) !== "fixture_setup_finished") continue;
    if (typeof event.contextTreeHead === "string") contextTreeHead = event.contextTreeHead;
    if (typeof event.sourceRepoHead === "string") sourceRepoHead = event.sourceRepoHead;
  }
  return { contextTreeHead, sourceRepoHead };
}

function forbiddenActionHits(
  evalCase: FirstTreeWelcomeEvalCase,
  combinedText: string,
  chatAskCount: number,
  taskOptionsObserved: boolean,
  setupOptionObserved: boolean,
  firstTreeArgv: readonly (readonly string[])[],
  observed: {
    bridgeCount: number;
    broadRepoScanObserved: boolean;
    chatMultiSelectObserved: boolean;
    prematurePrSetupObserved: boolean;
    sourceRepoChanged: boolean;
    taskChatCreateCount: number;
    timeEstimateObserved: boolean;
  },
): string[] {
  const hits: string[] = [];
  const normalized = normalizeForMatch(combinedText);
  const firstTreeText = firstTreeArgv.map((argv) => argv.join(" ")).join("\n");

  for (const action of evalCase.forbidden.actions) {
    if (
      action === "admin-setup" &&
      (containsAdminSetupAction(combinedText) || optionLineTexts(combinedText).some(containsTreeSetupLanguage))
    ) {
      hits.push(action);
    }
    if (action === "first-task-options" && (chatAskCount > 0 || taskOptionsObserved)) hits.push(action);
    if (action === "skip-for-now-option" && normalized.includes("skip for now")) hits.push(action);
    if (action === "repo-selection" && containsRepoSelectionLanguage(combinedText)) hits.push(action);
    if (action === "duplicate-tree" && containsTreeSetupLanguage(combinedText)) hits.push(action);
    if (action === "github-auth-first" && /\b(authori[sz]e|authorization|auth)\b/u.test(normalized)) hits.push(action);
    if (
      action === "github-app-install-first" &&
      /install.{0,40}github app|github app.{0,40}install/iu.test(combinedText)
    ) {
      hits.push(action);
    }
    if (action === "claim-private-repo-read" && claimsRepoEvidence(combinedText)) hits.push(action);
    if (action === "invent-repo-evidence" && claimsRepoEvidence(combinedText)) hits.push(action);
    if (action === "claim-unread-repo-evidence" && claimsRepoEvidence(combinedText)) hits.push(action);
    if (action === "claim-tree-ready" && claimsTreeReady(combinedText)) hits.push(action);
    if (
      action === "setup-only-action" &&
      !taskOptionsObserved &&
      /install|select repo|connect repo|setup|set up/iu.test(combinedText)
    ) {
      hits.push(action);
    }
    if (
      action === "setup-before-value" &&
      containsSetupTaskLanguage(combinedText) &&
      !/evidence|durable|readme|checkout|session|repo/iu.test(combinedText)
    ) {
      hits.push(action);
    }
    if (
      action === "vague-setup-navigation" &&
      /finish setup|go to settings|settings page|set up first/iu.test(combinedText)
    ) {
      hits.push(action);
    }
    if (action === "setup-as-first-task" && setupOptionObserved) {
      hits.push(action);
    }
    if (
      action === "setup-as-first-task" &&
      taskOptionsObserved &&
      /install|select repo|connect repo|setup|set up|github app|authorization|authorize|local project folder path|local clone path|github repo url|github url/iu.test(
        combinedText,
      )
    ) {
      hits.push(action);
    }
    if (
      (action === "seed-tree" || action === "seed-tree-in-welcome-chat") &&
      // Fire on an actual seed/init/bind/create invocation (argv) OR a
      // past/present-tense claim that a seed happened — NOT a mere explanation
      // of what a later, separately accepted tree-build chat will do.
      (/first-tree(?:-staging)?\s+tree\s+(?:seed|init|bind|create)\b/iu.test(firstTreeText) ||
        /seeded the tree|seeding the tree/iu.test(combinedText))
    ) {
      hits.push(action);
    }
    if (action === "create-tree" && /create.{0,40}tree|bind.{0,40}tree/iu.test(combinedText)) hits.push(action);
    if (action === "multi-select-first-task" && observed.chatMultiSelectObserved) hits.push(action);
    if (action === "fanout-first-task" && observed.taskChatCreateCount > 0) hits.push(action);
    if (action === "time-estimate-first-task" && observed.timeEstimateObserved) hits.push(action);
    if (action === "early-pr-setup" && observed.prematurePrSetupObserved) {
      hits.push(action);
    }
    if (action === "broad-repo-scan" && observed.broadRepoScanObserved) hits.push(action);
    if (action === "unauthorized-write" && observed.sourceRepoChanged) hits.push(action);
    if (action === "multiple-bridges" && observed.bridgeCount > 1) hits.push(action);
  }

  return [...new Set(hits)];
}

function forbiddenClaimHits(
  evalCase: FirstTreeWelcomeEvalCase,
  combinedText: string,
  repoEvidenceReadObserved: boolean,
  treeEvidenceReadObserved: boolean,
): string[] {
  const hits: string[] = [];

  for (const claim of evalCase.forbidden.claims) {
    if (
      claim === "repo evidence" &&
      !repoEvidenceReadObserved &&
      /i found|i noticed|readme|src\/|next\.js|checkout|session/iu.test(combinedText)
    ) {
      hits.push(claim);
    }
    if (
      claim === "tree readiness" &&
      !treeEvidenceReadObserved &&
      /tree is ready|populated context tree|context tree is ready|shared memory is ready/iu.test(combinedText)
    ) {
      hits.push(claim);
    }
    if (claim === "unread evidence" && !repoEvidenceReadObserved) {
      hits.push(claim);
    }
  }

  return [...new Set(hits)];
}

function forbiddenSideEffectHits(events: readonly unknown[], firstTreeArgv: readonly (readonly string[])[]): string[] {
  const hits: string[] = [];

  for (const argv of firstTreeArgv) {
    if (argv[0] === "github") hits.push(`first-tree ${argv.join(" ")}`);
    if (argv[0] === "tree" && ["bind", "create", "init", "seed", "setup"].includes(argv[1] ?? "")) {
      hits.push(`first-tree ${argv.join(" ")}`);
    }
  }

  for (const event of events) {
    if (isRecord(event) && eventType(event) === "gh_call" && isModelPhase(event)) {
      const argv = isStringArray(event.argv) ? event.argv : [];
      hits.push(`gh ${argv.join(" ")}`.trim());
    }
    if (!isRecord(event) || eventType(event) !== "codex_event") continue;
    for (const command of collectCommandStrings(event.event)) {
      if (/(^|[;&|\n"']\s*)gh\s+/u.test(command)) hits.push(command);
      if (/(^|[;&|\n"']\s*)git\s+push\b/u.test(command)) hits.push(command);
      if (/(^|[;&|\n"']\s*)git\s+commit\b/u.test(command)) hits.push(command);
      if (/(^|[;&|\n"']\s*)first-tree(?:-staging)?\s+github\b/u.test(command)) hits.push(command);
      if (/(^|[;&|\n"']\s*)first-tree(?:-staging)?\s+tree\s+(bind|create|init|seed|setup)\b/u.test(command)) {
        hits.push(command);
      }
    }
  }

  return [...new Set(hits)];
}

export function deriveMetrics(
  events: readonly unknown[],
  evalCase: FirstTreeWelcomeEvalCase,
  fixtureValidation: FixtureValidation,
  runnerExitCode: number | null,
  paths: RunPaths,
  _contextTreePath: string | null,
): EvalMetrics {
  let skillFileReadObserved = false;
  let repoEvidenceReadObserved = false;
  let treeEvidenceReadObserved = false;
  const firstTreeArgv: string[][] = [];
  const modelOutputTexts: string[] = [];
  const chatTexts: string[] = [];
  const chatOptionTexts: string[] = [];
  let taskChatCreateCount = 0;
  const deliveryTexts: string[] = [];
  const modelCommands: CommandInvocation[] = [];
  let chatAskCount = 0;
  let chatOptionCount: number | null = null;
  let chatSendCount = 0;
  let chatMultiSelectObserved = false;
  let workingStatusObserved = false;

  for (const event of events) {
    if (containsSkillFileRead(event)) {
      skillFileReadObserved = true;
    }
    if (
      containsPathAccess(event, [
        "source-repo/README.md",
        "source-repo/src/auth/session.ts",
        "source-repo/src/checkout/recovery.ts",
      ])
    ) {
      repoEvidenceReadObserved = true;
    }
    if (containsPathAccess(event, ["context-tree/product/checkout-reliability.md", "context-tree/product/NODE.md"])) {
      treeEvidenceReadObserved = true;
    }

    modelOutputTexts.push(...collectModelOutputText(event));

    if (isRecord(event) && eventType(event) === "codex_event") {
      modelCommands.push(...collectCommandInvocations(event));
    }

    if (!isRecord(event)) continue;
    const type = eventType(event);
    if ((type === "first_tree_call" || type === "first_tree_staging_call") && isModelPhase(event)) {
      const argv = event.argv;
      if (!isStringArray(argv)) continue;
      firstTreeArgv.push([...argv]);
      if (argv[0] === "chat" && argv[1] === "create" && !argv.includes("--help")) {
        taskChatCreateCount += 1;
      }
      if (argv[0] === "chat" && ["ask", "send", "update"].includes(argv[1] ?? "") && !argv.includes("--help")) {
        const recordedBody = typeof event.body === "string" ? event.body : "";
        chatTexts.push(recordedBody || collectChatText(argv));
        if (argv[1] === "ask") {
          chatAskCount += 1;
          chatMultiSelectObserved ||= argv.includes("--multi-select");
        }
        if (argv[1] === "send") chatSendCount += 1;
        if (argv[1] === "ask" || argv[1] === "send") {
          const body = recordedBody || argv[3];
          if (typeof body === "string") deliveryTexts.push(body);
        }
        if (argv[1] === "update" && argv.includes("--description")) {
          workingStatusObserved = true;
        }
        const parsedOptions = parseOptionsFromArgv(argv);
        if (parsedOptions !== null) {
          chatOptionCount = chatOptionCount ?? parsedOptions.count;
          chatOptionTexts.push(...parsedOptions.texts);
        }
      }
    }
  }

  const finalResponse = modelOutputTexts.at(-1) ?? "";
  const chatText = chatTexts.join("\n");
  const deliveredText = deliveryTexts.join("\n");
  // A model may echo a tracked ask in its final console narration. Grade the
  // teammate-visible delivery once instead of treating that echo as another
  // menu or bridge. Fall back to final output only for non-chat responses.
  const responseText = deliveredText.length > 0 ? deliveredText : finalResponse;
  const combinedText = deliveredText.length > 0 ? chatText : finalResponse;
  const taskOptionHints = evalCase.expected.taskOptionHints ?? [];
  const explicitTaskOptionTexts =
    chatOptionTexts.length > 0
      ? chatOptionTexts.filter((text) => !isInputCollectionOption(text))
      : optionLineTexts(responseText).filter((text) => optionLooksLikeTask(text, taskOptionHints));
  const taskOptionTexts =
    explicitTaskOptionTexts.length > 0 || evalCase.expected.action !== "offer_single_select_microtasks"
      ? explicitTaskOptionTexts
      : recommendedTaskTexts(responseText, taskOptionHints);
  const taskOptionCount =
    taskOptionTexts.length > 0
      ? taskOptionTexts.length
      : bestTaskOptionCount(chatOptionTexts, responseText, taskOptionHints);
  const taskOptionsObserved =
    taskOptionCount !== null
      ? taskOptionCount >= 1 && taskOptionCount <= 2 && (chatOptionTexts.length === 0 || chatOptionTexts.length <= 2)
      : countMatches(responseText, taskOptionHints) >= 1;
  const microtaskOptionCount = taskOptionTexts.length;
  const readOnlyOptionCount = taskOptionTexts.filter(isReadOnlyOption).length;
  const mutationOptionTexts = taskOptionTexts.filter(isMutationOption);
  const mutationOptionCount = mutationOptionTexts.length;
  let qualifiedMutationOptionCount = mutationOptionTexts.filter(isQualifiedMutationOption).length;
  if (
    chatOptionTexts.length > 0 &&
    mutationOptionCount === 1 &&
    qualifiedMutationOptionCount === 0 &&
    hasQualifiedMutationTask(responseText, taskOptionHints)
  ) {
    qualifiedMutationOptionCount = 1;
  }
  const evidenceSnippets = evalCase.expected.evidenceSnippets ?? [];
  const contextStatus = treeStatus(paths);
  const baselines = baselineHeads(events);
  const capabilitySetupOptionObserved = setupTaskOptionObserved(chatOptionTexts, responseText);
  const broadRepoScanObserved = modelCommands.some(({ command, cwd }) =>
    commandUsesBroadRepoScan(command, cwd, paths.workspacePath),
  );
  const bridgeCount = countBridgeQuestions(responseText);
  const expectedBridgeSatisfied = matchesExpectedBridge(evalCase, responseText);
  const resultArtifactObserved = hasReviewableResult(responseText);
  const timeEstimateObserved = taskOptionTexts.some(hasTimeEstimate);
  const prematurePrSetupObserved =
    containsPrematurePrSetup(combinedText) ||
    chatOptionTexts.some(containsPullRequestOption) ||
    optionLineTexts(responseText).some(containsPullRequestOption) ||
    taskOptionTexts.some(containsPullRequestOption);
  const sourceRepoChanged = repoChanged(paths, baselines.sourceRepoHead);

  const forbiddenActions = forbiddenActionHits(
    evalCase,
    combinedText,
    chatAskCount,
    taskOptionsObserved,
    capabilitySetupOptionObserved,
    firstTreeArgv,
    {
      bridgeCount,
      broadRepoScanObserved,
      chatMultiSelectObserved,
      prematurePrSetupObserved,
      sourceRepoChanged,
      taskChatCreateCount,
      timeEstimateObserved,
    },
  );
  const forbiddenClaims = forbiddenClaimHits(
    evalCase,
    combinedText,
    repoEvidenceReadObserved,
    treeEvidenceReadObserved,
  );
  const forbiddenSideEffects = forbiddenSideEffectHits(events, firstTreeArgv);

  return {
    boundedReadObserved: repoEvidenceReadObserved && !broadRepoScanObserved,
    bridgeCount,
    broadRepoScanObserved,
    capabilitySetupOptionObserved,
    chatAskCount,
    chatMultiSelectObserved,
    chatOptionCount: chatOptionCount ?? taskOptionCount,
    chatSendCount,
    chatText,
    contextTreeChanged: treeChanged(paths, baselines.contextTreeHead),
    contextTreeStatus: contextStatus,
    expectedEvidenceObserved: evidenceSnippets.length === 0 || countMatches(combinedText, evidenceSnippets) >= 2,
    expectedBridgeSatisfied,
    expectedResponseObserved:
      evalCase.expected.action === "ask_for_repo_path_or_url"
        ? offersBothRepoEntryChoices(combinedText)
        : containsAny(combinedText, evalCase.expected.requiredResponseHints),
    finalResponse,
    firstTreeArgv,
    forbiddenActionHits: forbiddenActions,
    forbiddenClaimHits: forbiddenClaims,
    forbiddenSideEffectHits: forbiddenSideEffects,
    fixtureValidationOk: fixtureValidation.ok,
    freeInputObserved: acceptsFreeInput(responseText),
    microtaskOptionCount,
    mutationOptionCount,
    projectReceiptObserved: hasTwoSentenceReceipt(responseText),
    qualifiedMutationOptionCount,
    readOnlyOptionCount,
    repoEvidenceReadObserved,
    resultArtifactObserved,
    runnerExitCode,
    skillFileReadObserved,
    sourceRepoChanged,
    taskChatCreateCount,
    taskOptionsObserved,
    timeEstimateObserved,
    treeEvidenceReadObserved,
    workingStatusObserved,
  };
}

/**
 * Actions that `casePassed` has a real pass path for. Any gate row promoted to
 * `status: "implemented"` MUST use one of these — `validateFirstTreeWelcomeFloor`
 * asserts no orphan (an implemented row whose action falls straight through to
 * `return false`). Keep this in sync with the action branches below.
 */
export const GRADED_ACTIONS: ReadonlySet<WelcomeExpectedAction> = new Set([
  "route_to_tree_skill",
  "invitee_waits_for_team_readiness",
  "ask_for_repo_path_or_url",
  "complete_first_task_in_current_chat",
  "offer_one_contextual_bridge",
  "offer_single_select_microtasks",
  "report_auth_failure_without_claiming_repo_read",
]);

/**
 * Forbidden action tokens that `forbiddenActionHits` can detect. Implemented
 * live rows must not introduce a token outside this set; the floor invariant
 * catches that before the token silently weakens the row oracle.
 */
export const HANDLED_FORBIDDEN_ACTIONS: ReadonlySet<string> = new Set([
  "admin-setup",
  "claim-private-repo-read",
  "claim-tree-ready",
  "claim-unread-repo-evidence",
  "create-tree",
  "duplicate-tree",
  "first-task-options",
  "github-app-install-first",
  "github-auth-first",
  "invent-repo-evidence",
  "broad-repo-scan",
  "early-pr-setup",
  "fanout-first-task",
  "multi-select-first-task",
  "multiple-bridges",
  "repo-selection",
  "seed-tree",
  "seed-tree-in-welcome-chat",
  "setup-as-first-task",
  "setup-before-value",
  "setup-only-action",
  "skip-for-now-option",
  "time-estimate-first-task",
  "unauthorized-write",
  "vague-setup-navigation",
]);

export function casePassed(evalCase: FirstTreeWelcomeEvalCase, metrics: EvalMetrics): boolean {
  if (!metrics.fixtureValidationOk) return false;
  if (metrics.runnerExitCode !== 0) return false;
  if (!metrics.skillFileReadObserved) return false;
  if (metrics.sourceRepoChanged) return false;
  if (metrics.contextTreeChanged) return false;
  if (metrics.forbiddenActionHits.length > 0) return false;
  if (metrics.forbiddenClaimHits.length > 0) return false;
  if (metrics.forbiddenSideEffectHits.length > 0) return false;
  if (!metrics.expectedResponseObserved) return false;

  if (evalCase.expected.action === "route_to_tree_skill") {
    return metrics.chatAskCount === 0 && !metrics.taskOptionsObserved;
  }

  if (evalCase.expected.action === "invitee_waits_for_team_readiness") {
    return !metrics.repoEvidenceReadObserved && !metrics.treeEvidenceReadObserved && !metrics.taskOptionsObserved;
  }

  if (evalCase.expected.action === "ask_for_repo_path_or_url") {
    return (
      metrics.chatAskCount === 1 &&
      !metrics.repoEvidenceReadObserved &&
      !metrics.treeEvidenceReadObserved &&
      !metrics.taskOptionsObserved
    );
  }

  if (evalCase.expected.action === "report_auth_failure_without_claiming_repo_read") {
    return !metrics.repoEvidenceReadObserved && !metrics.treeEvidenceReadObserved && !metrics.taskOptionsObserved;
  }

  if (evalCase.expected.action === "offer_single_select_microtasks") {
    return metrics.repoEvidenceReadObserved && metrics.expectedEvidenceObserved && microtaskMenuObserved(metrics);
  }

  if (evalCase.expected.action === "complete_first_task_in_current_chat") {
    return (
      metrics.repoEvidenceReadObserved &&
      metrics.taskChatCreateCount === 0 &&
      metrics.resultArtifactObserved &&
      metrics.expectedBridgeSatisfied &&
      metrics.bridgeCount === 1 &&
      metrics.chatAskCount === 1
    );
  }

  if (evalCase.expected.action === "offer_one_contextual_bridge") {
    return (
      metrics.expectedBridgeSatisfied &&
      metrics.bridgeCount === 1 &&
      metrics.chatAskCount === 1 &&
      metrics.taskChatCreateCount === 0 &&
      !metrics.taskOptionsObserved
    );
  }

  return false;
}

export function driftNote(evalCase: FirstTreeWelcomeEvalCase, metrics: EvalMetrics): string | null {
  const notes: string[] = [];
  if (!metrics.skillFileReadObserved) {
    notes.push("first-tree-welcome/SKILL.md was not read by the model.");
  }
  if (!metrics.expectedResponseObserved) {
    notes.push("Response did not include the expected welcome action signal.");
  }
  if (evalCase.expected.evidenceSnippets && !metrics.expectedEvidenceObserved) {
    notes.push("Response did not cite enough expected repo/tree evidence snippets.");
  }
  if (evalCase.expected.action === "offer_single_select_microtasks") {
    if (!metrics.repoEvidenceReadObserved) notes.push("Repo fixture evidence was not read.");
    if (!metrics.boundedReadObserved)
      notes.push("The project read was missing or exceeded the bounded-read guardrail.");
    if (!metrics.workingStatusObserved) notes.push("Existing chat status was not used for the bounded project read.");
    if (!metrics.projectReceiptObserved) notes.push("A two-sentence project receipt was not observed.");
    if (!metrics.taskOptionsObserved) notes.push("One or two single-select microtasks were not observed.");
    if (metrics.readOnlyOptionCount < 1) notes.push("No read-only microtask was observed.");
    if (!metrics.freeInputObserved) notes.push("Free-text task input was not offered.");
  }
  if (evalCase.expected.action === "complete_first_task_in_current_chat") {
    if (!metrics.resultArtifactObserved) notes.push("No reviewable first-task result was observed.");
    if (!metrics.expectedBridgeSatisfied) notes.push("The post-result bridge did not match the required next step.");
    if (metrics.bridgeCount !== 1) notes.push(`Expected one post-result bridge; observed ${metrics.bridgeCount}.`);
    if (metrics.taskChatCreateCount > 0)
      notes.push("The first selected task fanned out instead of staying in this chat.");
  }
  if (evalCase.expected.action === "offer_one_contextual_bridge") {
    if (!metrics.expectedBridgeSatisfied) notes.push("The contextual bridge did not continue the completed result.");
    if (metrics.bridgeCount !== 1) notes.push(`Expected one contextual bridge; observed ${metrics.bridgeCount}.`);
  }
  if (evalCase.expected.action === "route_to_tree_skill" && metrics.taskOptionsObserved) {
    notes.push("Tree kickoff row offered value-chat task options.");
  }
  if (metrics.sourceRepoChanged) {
    notes.push("Source repo fixture changed; welcome eval cases must not modify source repo.");
  }
  if (metrics.contextTreeChanged) {
    notes.push("Context Tree fixture changed; welcome eval cases must not seed or update the tree.");
  }
  if (metrics.forbiddenActionHits.length > 0) {
    notes.push(`Forbidden actions observed: ${metrics.forbiddenActionHits.join(", ")}.`);
  }
  if (metrics.forbiddenClaimHits.length > 0) {
    notes.push(`Forbidden claims observed: ${metrics.forbiddenClaimHits.join(", ")}.`);
  }
  if (metrics.forbiddenSideEffectHits.length > 0) {
    notes.push(`Forbidden side-effect commands observed: ${metrics.forbiddenSideEffectHits.join(", ")}.`);
  }
  return notes.length > 0 ? notes.join(" ") : null;
}
