import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { runCommand } from "../../core/commands.js";
import { findStringValue, isRecord, isStringArray } from "../../core/events.js";
import type { RunPaths } from "../../core/types.js";
import type { EvalMetrics, FirstTreeWriteEvalCase, FixtureValidation, TreeStateSnapshot } from "./types.js";

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
  if (!findStringValue(nestedEvent, (value) => value.includes("first-tree-write/SKILL.md"))) {
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
  for (const needle of needles) {
    const normalizedNeedle = normalizeForMatch(needle);
    if (normalizedNeedle.length > 0 && !normalizedHaystack.includes(normalizedNeedle)) {
      return false;
    }
  }
  return true;
}

function argvIsVerify(argv: readonly string[]): boolean {
  return argv[0] === "tree" && argv[1] === "verify";
}

function collectMarkdownFiles(root: string): string[] {
  const files: string[] = [];
  function walk(dir: string): void {
    const entries = existsSync(dir) ? readdirSync(dir).sort() : [];
    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules") continue;
      const child = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(child);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(child);
        continue;
      }
      if (entry.endsWith(".md")) {
        files.push(child);
      }
    }
  }
  walk(root);
  return files;
}

function contextTreeMarkdown(contextTreePath: string): string {
  const chunks: string[] = [];
  for (const file of collectMarkdownFiles(contextTreePath)) {
    chunks.push(`\n--- ${relative(contextTreePath, file)} ---\n${readFileSync(file, "utf8")}`);
  }
  return chunks.join("\n");
}

export function snapshotTreeState(contextTreePath: string): TreeStateSnapshot {
  const status = runCommand("git", ["status", "--porcelain"], contextTreePath).stdout;
  const diff = runCommand("git", ["diff", "--", "."], contextTreePath).stdout;
  return { diff, status };
}

function sourceRepoChanged(paths: RunPaths): boolean {
  const sourceRepoPath = join(paths.workspacePath, "source-repo");
  const status = runCommand("git", ["status", "--porcelain"], sourceRepoPath);
  return status.stdout.trim().length > 0;
}

export function deriveMetrics(
  events: readonly unknown[],
  evalCase: FirstTreeWriteEvalCase,
  fixtureValidation: FixtureValidation,
  runnerExitCode: number | null,
  paths: RunPaths,
  contextTreePath: string,
): EvalMetrics {
  let skillFileReadObserved = false;
  const firstTreeArgv: string[][] = [];
  const firstTreeCommandResults: Array<{ argv: string[]; exitCode: number }> = [];
  const modelOutputTexts: string[] = [];

  for (const event of events) {
    if (containsSkillFileRead(event)) {
      skillFileReadObserved = true;
    }

    modelOutputTexts.push(...collectModelOutputText(event));

    if (!isRecord(event)) continue;
    const type = eventType(event);
    if ((type === "first_tree_call" || type === "first_tree_result") && isModelPhase(event)) {
      const argv = event.argv;
      if (!isStringArray(argv)) continue;

      if (type === "first_tree_call") {
        firstTreeArgv.push([...argv]);
      }

      if (type === "first_tree_result" && typeof event.exitCode === "number") {
        firstTreeCommandResults.push({ argv: [...argv], exitCode: event.exitCode });
      }
    }
  }

  const treeState = snapshotTreeState(contextTreePath);
  const finalResponse = modelOutputTexts.at(-1) ?? "";
  const markdown = contextTreeMarkdown(contextTreePath);
  const forbiddenContentHits = evalCase.forbidden.content.filter((pattern) => markdown.includes(pattern));
  const requiredDiffSnippets = evalCase.expected.requiredDiffSnippets ?? [];
  const verifySucceeded = firstTreeCommandResults.some((result) => argvIsVerify(result.argv) && result.exitCode === 0);

  return {
    expectedDiffSnippetsObserved:
      requiredDiffSnippets.length === 0 || containsAll(treeState.diff, requiredDiffSnippets),
    expectedResponseObserved: containsAny(finalResponse, evalCase.expected.responseHints),
    finalResponse,
    firstTreeArgv,
    firstTreeCommandResults,
    fixtureValidationOk: fixtureValidation.ok,
    forbiddenContentHits,
    runnerExitCode,
    skillFileReadObserved,
    sourceRepoChanged: sourceRepoChanged(paths),
    treeChanged: treeState.status.trim().length > 0,
    treeDiff: treeState.diff,
    treeStatus: treeState.status,
    verifySucceeded,
  };
}

export function casePassed(evalCase: FirstTreeWriteEvalCase, metrics: EvalMetrics): boolean {
  if (!metrics.fixtureValidationOk) return false;
  if (metrics.runnerExitCode !== 0) return false;
  if (!metrics.skillFileReadObserved) return false;
  if (metrics.sourceRepoChanged) return false;
  if (metrics.forbiddenContentHits.length > 0) return false;
  if (!metrics.expectedResponseObserved) return false;

  if (evalCase.expected.treeDiff === "none") {
    return !metrics.treeChanged;
  }

  return (
    metrics.treeChanged &&
    metrics.expectedDiffSnippetsObserved &&
    (!evalCase.expected.requireVerify || metrics.verifySucceeded)
  );
}

export function driftNote(evalCase: FirstTreeWriteEvalCase, metrics: EvalMetrics): string | null {
  const notes: string[] = [];
  if (!metrics.skillFileReadObserved) {
    notes.push("first-tree-write/SKILL.md was not read by the model.");
  }
  if (evalCase.expected.treeDiff === "none" && metrics.treeChanged) {
    notes.push("Context Tree changed even though this case expected no tree diff.");
  }
  if (evalCase.expected.treeDiff === "minimal" && !metrics.treeChanged) {
    notes.push("Context Tree did not change even though this case expected a tree diff.");
  }
  if (evalCase.expected.treeDiff === "minimal" && !metrics.expectedDiffSnippetsObserved) {
    notes.push("Context Tree diff did not contain all required durable-decision snippets.");
  }
  if (evalCase.expected.requireVerify && !metrics.verifySucceeded) {
    notes.push("Required first-tree tree verify command did not succeed during model phase.");
  }
  if (metrics.sourceRepoChanged) {
    notes.push("Source repo fixture changed; write eval cases must not modify source repo.");
  }
  if (metrics.forbiddenContentHits.length > 0) {
    notes.push(`Forbidden content appeared in Context Tree markdown: ${metrics.forbiddenContentHits.join(", ")}.`);
  }
  if (!metrics.expectedResponseObserved) {
    notes.push("Final response did not include the expected refusal/update signal.");
  }
  return notes.length > 0 ? notes.join(" ") : null;
}
