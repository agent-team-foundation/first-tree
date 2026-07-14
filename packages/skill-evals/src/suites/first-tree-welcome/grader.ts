import { existsSync } from "node:fs";
import { join } from "node:path";

import { runCommand } from "../../core/commands.js";
import { findStringValue, isRecord, isStringArray } from "../../core/events.js";
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

function containsRepoRemoteRead(event: unknown): boolean {
  if (!isRecord(event) || eventType(event) !== "codex_event") return false;
  const serialized = JSON.stringify(event.event) ?? "";
  return (
    serialized.includes("source-repo") &&
    /git.{0,80}(?:remote|get-url)|(?:remote|get-url).{0,80}git|source-repo\/\.git\/config/iu.test(serialized)
  );
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

function collectCommandStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    const commands: string[] = [];
    for (const item of value) {
      commands.push(...collectCommandStrings(item));
    }
    return commands;
  }
  if (!isRecord(value)) return [];

  const commands: string[] = [];
  const command = value.command;
  if (typeof command === "string") commands.push(command);
  const cmd = value.cmd;
  if (typeof cmd === "string") commands.push(cmd);

  for (const item of Object.values(value)) {
    if (isRecord(item) || Array.isArray(item)) {
      commands.push(...collectCommandStrings(item));
    }
  }
  return commands;
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
  return /install|create.{0,30}(context\s+)?tree|seed.{0,20}tree|tree.{0,20}setup|setup.{0,20}tree|select.{0,20}repo|connect.{0,20}repo|authori[sz]e|authorization|安装.{0,20}github app|授权/iu.test(
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

function containsRepoConfirmationLanguage(text: string): boolean {
  return /(?:use|save|set|make|keep).{0,50}(?:team|default|long[- ]term).{0,30}(?:repo|repository|code)|(?:repo|repository).{0,40}(?:team default|long[- ]term team code)/iu.test(
    text,
  );
}

function repoConfirmationObserved(chatOptionTexts: readonly string[], combinedText: string): boolean {
  const candidateObserved = /github\.com[\s/]+acme[\s/]+support-dashboard/iu.test(combinedText);
  const consequenceObserved = /team.{0,25}(?:repo|repository)|(?:repo|repository).{0,25}team/iu.test(combinedText);
  const positiveOptionObserved = chatOptionTexts.some((text) =>
    /use.{0,20}team.{0,20}(?:repo|repository)/iu.test(text),
  );
  const temporaryOptionObserved = chatOptionTexts.some((text) =>
    /only this time|temporary|do not save|don't save/iu.test(text),
  );
  return candidateObserved && consequenceObserved && positiveOptionObserved && temporaryOptionObserved;
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

function setupTaskOptionObserved(chatOptionTexts: readonly string[], combinedText: string): boolean {
  return (
    chatOptionTexts.some((text) => containsSetupTaskLanguage(text)) ||
    optionLineTexts(combinedText).some((line) => containsSetupTaskLanguage(line))
  );
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
    if (action === "repo-confirmation" && containsRepoConfirmationLanguage(combinedText)) hits.push(action);
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
      // past/present-tense claim that a seed happened — NOT a mere gloss that a
      // separate tree-build option "will seed" the tree, which is now offered.
      (/first-tree(?:-staging)?\s+tree\s+(?:seed|init|bind|create)\b/iu.test(firstTreeText) ||
        /seeded the tree|seeding the tree/iu.test(combinedText))
    ) {
      hits.push(action);
    }
    if (action === "create-tree" && /create.{0,40}tree|bind.{0,40}tree/iu.test(combinedText)) hits.push(action);
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
    if (claim === "unread evidence" && (!repoEvidenceReadObserved || !treeEvidenceReadObserved)) {
      hits.push(claim);
    }
  }

  return [...new Set(hits)];
}

function forbiddenSideEffectHits(events: readonly unknown[], firstTreeArgv: readonly (readonly string[])[]): string[] {
  const hits: string[] = [];

  for (const argv of firstTreeArgv) {
    if (argv[0] === "github") hits.push(`first-tree ${argv.join(" ")}`);
    if (argv[0] === "agent" && argv[1] === "config" && argv[2] === "add-repo") {
      hits.push(`first-tree ${argv.join(" ")}`);
    }
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
      if (/curl\b[^\n]*\/orgs\/[^\s/]+\/resources\b/iu.test(command)) hits.push(command);
      if (/(^|[;&|\n"']\s*)first-tree(?:-staging)?\s+github\b/u.test(command)) hits.push(command);
      if (/(^|[;&|\n"']\s*)first-tree(?:-staging)?\s+agent\s+config\s+add-repo\b/u.test(command)) {
        hits.push(command);
      }
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
  let repoRemoteReadObserved = false;
  let treeEvidenceReadObserved = false;
  const firstTreeArgv: string[][] = [];
  const modelOutputTexts: string[] = [];
  const chatTexts: string[] = [];
  const chatOptionTexts: string[] = [];
  let chatAskCount = 0;
  let chatOptionCount: number | null = null;

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
    if (containsRepoRemoteRead(event)) {
      repoRemoteReadObserved = true;
    }
    if (containsPathAccess(event, ["context-tree/product/checkout-reliability.md", "context-tree/product/NODE.md"])) {
      treeEvidenceReadObserved = true;
    }

    modelOutputTexts.push(...collectModelOutputText(event));

    if (!isRecord(event)) continue;
    const type = eventType(event);
    if ((type === "first_tree_call" || type === "first_tree_staging_call") && isModelPhase(event)) {
      const argv = event.argv;
      if (!isStringArray(argv)) continue;
      firstTreeArgv.push([...argv]);
      if (argv[0] === "chat" && ["ask", "send", "update"].includes(argv[1] ?? "") && !argv.includes("--help")) {
        chatTexts.push(collectChatText(argv));
        if (argv[1] === "ask") chatAskCount += 1;
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
  const combinedText = `${chatText}\n${finalResponse}`;
  const taskOptionHints = evalCase.expected.taskOptionHints ?? [];
  const taskOptionCount = bestTaskOptionCount(chatOptionTexts, combinedText, taskOptionHints);
  const taskOptionsObserved =
    taskOptionCount !== null
      ? taskOptionCount >= 2 && taskOptionCount <= 3
      : countMatches(combinedText, taskOptionHints) >= 2;
  const evidenceSnippets = evalCase.expected.evidenceSnippets ?? [];
  const contextStatus = treeStatus(paths);
  const baselines = baselineHeads(events);
  const treeBuildOptionObserved = setupTaskOptionObserved(chatOptionTexts, combinedText);
  const repoConfirmation = repoConfirmationObserved(chatOptionTexts, combinedText);

  const forbiddenActions = forbiddenActionHits(
    evalCase,
    combinedText,
    chatAskCount,
    taskOptionsObserved,
    treeBuildOptionObserved,
    firstTreeArgv,
  );
  const forbiddenClaims = forbiddenClaimHits(
    evalCase,
    combinedText,
    repoEvidenceReadObserved,
    treeEvidenceReadObserved,
  );
  const forbiddenSideEffects = forbiddenSideEffectHits(events, firstTreeArgv);

  return {
    chatAskCount,
    chatOptionCount: chatOptionCount ?? taskOptionCount,
    chatText,
    contextTreeChanged: treeChanged(paths, baselines.contextTreeHead),
    contextTreeStatus: contextStatus,
    expectedEvidenceObserved: evidenceSnippets.length === 0 || countMatches(combinedText, evidenceSnippets) >= 2,
    expectedResponseObserved: containsAny(combinedText, evalCase.expected.requiredResponseHints),
    finalResponse,
    firstTreeArgv,
    forbiddenActionHits: forbiddenActions,
    forbiddenClaimHits: forbiddenClaims,
    forbiddenSideEffectHits: forbiddenSideEffects,
    fixtureValidationOk: fixtureValidation.ok,
    repoConfirmationObserved: repoConfirmation,
    repoEvidenceReadObserved,
    repoRemoteReadObserved,
    runnerExitCode,
    skillFileReadObserved,
    sourceRepoChanged: repoChanged(paths, baselines.sourceRepoHead),
    taskOptionsObserved,
    treeBuildOptionObserved,
    treeEvidenceReadObserved,
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
  "offer_invitee_value_without_admin_setup",
  "ask_for_repo_path_or_url",
  "report_auth_failure_without_claiming_repo_read",
  "value_first_then_setup_handoff",
  "confirm_ad_hoc_repo_after_value",
  "offer_tree_build_with_code_value",
  "offer_bounded_first_tasks_from_repo_and_tree",
  "offer_repo_value_without_claiming_tree_ready",
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
  "repo-confirmation",
  "repo-selection",
  "seed-tree",
  "seed-tree-in-welcome-chat",
  "setup-as-first-task",
  "setup-before-value",
  "setup-only-action",
  "skip-for-now-option",
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

  if (evalCase.expected.action === "offer_invitee_value_without_admin_setup") {
    return (
      metrics.repoEvidenceReadObserved &&
      metrics.treeEvidenceReadObserved &&
      metrics.expectedEvidenceObserved &&
      metrics.taskOptionsObserved
    );
  }

  if (evalCase.expected.action === "ask_for_repo_path_or_url") {
    return !metrics.repoEvidenceReadObserved && !metrics.treeEvidenceReadObserved && !metrics.taskOptionsObserved;
  }

  if (evalCase.expected.action === "report_auth_failure_without_claiming_repo_read") {
    return !metrics.repoEvidenceReadObserved && !metrics.treeEvidenceReadObserved && !metrics.taskOptionsObserved;
  }

  if (evalCase.expected.action === "value_first_then_setup_handoff") {
    return metrics.repoEvidenceReadObserved && !metrics.treeEvidenceReadObserved;
  }

  if (evalCase.expected.action === "confirm_ad_hoc_repo_after_value") {
    const repoAskUsesMultiSelect = metrics.firstTreeArgv.some(
      (argv) => argv[0] === "chat" && argv[1] === "ask" && argv.includes("--multi-select"),
    );
    return (
      metrics.repoRemoteReadObserved &&
      !metrics.treeEvidenceReadObserved &&
      metrics.chatAskCount === 1 &&
      metrics.chatOptionCount === 2 &&
      metrics.repoConfirmationObserved &&
      !repoAskUsesMultiSelect &&
      !metrics.treeBuildOptionObserved
    );
  }

  if (evalCase.expected.action === "offer_tree_build_with_code_value") {
    return metrics.repoEvidenceReadObserved && !metrics.treeEvidenceReadObserved && metrics.taskOptionsObserved;
  }

  if (evalCase.expected.action === "offer_bounded_first_tasks_from_repo_and_tree") {
    return (
      metrics.repoEvidenceReadObserved &&
      metrics.treeEvidenceReadObserved &&
      metrics.expectedEvidenceObserved &&
      metrics.taskOptionsObserved
    );
  }
  if (evalCase.expected.action === "offer_repo_value_without_claiming_tree_ready") {
    return metrics.repoEvidenceReadObserved && !metrics.treeEvidenceReadObserved && metrics.taskOptionsObserved;
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
  if (evalCase.expected.action === "offer_bounded_first_tasks_from_repo_and_tree") {
    if (!metrics.repoEvidenceReadObserved) notes.push("Repo fixture evidence was not read.");
    if (!metrics.treeEvidenceReadObserved) notes.push("Context Tree fixture evidence was not read.");
    if (!metrics.taskOptionsObserved) notes.push("Two or three bounded first-task options were not observed.");
  }
  if (evalCase.expected.action === "confirm_ad_hoc_repo_after_value") {
    if (!metrics.repoRemoteReadObserved) notes.push("The ad-hoc repo's Git remotes were not inspected.");
    if (!metrics.repoConfirmationObserved) {
      notes.push("The exact repo candidate and two confirmation choices were not observed.");
    }
    if (metrics.chatAskCount !== 1 || metrics.chatOptionCount !== 2) {
      notes.push("The post-value repo confirmation was not one tracked ask with exactly two choices.");
    }
    if (
      metrics.firstTreeArgv.some((argv) => argv[0] === "chat" && argv[1] === "ask" && argv.includes("--multi-select"))
    ) {
      notes.push("The mutually exclusive repo confirmation incorrectly used multi-select.");
    }
    if (metrics.treeBuildOptionObserved) notes.push("The Context Tree offer was stacked with the repo confirmation.");
  }
  if (
    evalCase.expected.action === "offer_invitee_value_without_admin_setup" ||
    evalCase.expected.action === "offer_tree_build_with_code_value" ||
    evalCase.expected.action === "offer_repo_value_without_claiming_tree_ready" ||
    evalCase.expected.action === "value_first_then_setup_handoff"
  ) {
    if (!metrics.repoEvidenceReadObserved) notes.push("Repo fixture evidence was not read.");
  }
  if (evalCase.expected.action === "offer_invitee_value_without_admin_setup" && !metrics.treeEvidenceReadObserved) {
    notes.push("Context Tree fixture evidence was not read.");
  }
  if (
    (evalCase.expected.action === "offer_invitee_value_without_admin_setup" ||
      evalCase.expected.action === "offer_tree_build_with_code_value" ||
      evalCase.expected.action === "offer_repo_value_without_claiming_tree_ready") &&
    !metrics.taskOptionsObserved
  ) {
    notes.push("Two or three bounded first-task options were not observed.");
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
