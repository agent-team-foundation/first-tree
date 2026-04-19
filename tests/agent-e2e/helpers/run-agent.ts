/**
 * Thin wrapper around the existing eval session runner, specialised
 * for small-box skill-behaviour tests.
 *
 * The real agent subprocess runner lives at evals/helpers/session-runner.ts
 * (adapted from gstack). This wrapper:
 *   - defaults to claude-code with a conservative maxTurns
 *   - sets up a tmpdir with an initialised git repo
 *   - exposes a concise `expectCommandInvoked(toolCalls, regex)` assert
 *     that matches against Bash tool-use inputs
 *   - guards behind FIRST_TREE_AGENT_TESTS=1 so it's a no-op elsewhere
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSession } from "#evals/helpers/session-runner.js";
import type {
  AgentConfig,
  SessionResult,
} from "#evals/helpers/types.js";

export const DEFAULT_AGENT: AgentConfig = {
  cli: "claude-code",
  model: "claude-sonnet-4-5",
};

export interface AgentRunResult extends SessionResult {
  workingDirectory: string;
  cleanup: () => void;
}

export function agentAvailable(): boolean {
  if (process.env.FIRST_TREE_AGENT_TESTS !== "1") return false;
  if (!process.env.ANTHROPIC_API_KEY) return false;
  return true;
}

/**
 * Create a tmp git repo seeded with the given files and return its path.
 * Cleanup is the caller's responsibility (use the returned function).
 */
export function makeSeedRepo(files: Record<string, string>): {
  path: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "first-tree-agent-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=first-tree-agent-tests@example.com",
      "-c",
      "user.name=First Tree Agent Tests",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "initial",
    ],
    { cwd: dir },
  );
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return {
    path: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Run an agent CLI subprocess in the given working directory.
 * Defaults chosen for cheap skill tests: sonnet, 6 turns, 120s.
 */
export async function runAgent(options: {
  prompt: string;
  workingDirectory: string;
  maxTurns?: number;
  timeout?: number;
  agent?: AgentConfig;
  testName?: string;
}): Promise<SessionResult> {
  return runSession({
    prompt: options.prompt,
    workingDirectory: options.workingDirectory,
    agent: options.agent ?? DEFAULT_AGENT,
    maxTurns: options.maxTurns ?? 6,
    timeout: options.timeout ?? 120_000,
    testName: options.testName,
  });
}

/** Every Bash tool call the agent made during the session. */
export function bashInvocations(result: SessionResult): string[] {
  return result.toolCalls
    .filter((tc) => tc.tool === "Bash")
    .map((tc) => {
      const input = tc.input as { command?: string };
      return input?.command ?? "";
    });
}

/**
 * Return the list of bash invocations that match the predicate.
 * Useful for building more-specific assertions.
 */
export function bashMatching(
  result: SessionResult,
  pattern: RegExp,
): string[] {
  return bashInvocations(result).filter((cmd) => pattern.test(cmd));
}

/**
 * Return true iff at least one Bash tool call matches.
 * Paired with vitest `expect(...).toBe(true)`; the error message names
 * the actual invocations for fast triage.
 */
export function invokedCommand(
  result: SessionResult,
  pattern: RegExp,
): { matched: boolean; commands: string[] } {
  const commands = bashInvocations(result);
  const matched = commands.some((cmd) => pattern.test(cmd));
  return { matched, commands };
}

/**
 * Assertion helper: throw with a helpful message if the agent did NOT
 * invoke any Bash command matching `pattern` during the session.
 */
export function assertInvokedCommand(
  result: SessionResult,
  pattern: RegExp,
  hint: string,
): void {
  const { matched, commands } = invokedCommand(result, pattern);
  if (!matched) {
    throw new Error(
      [
        `Agent did not invoke ${pattern} (${hint}).`,
        "Bash commands issued:",
        ...commands.map((c) => `  - ${c.slice(0, 200)}`),
        `(exit_reason=${result.exitReason}, turns=${result.toolCalls.length})`,
      ].join("\n"),
    );
  }
}

/**
 * Assertion helper: throw with a helpful message if the agent DID
 * invoke any Bash command matching `pattern`. Used to guard against
 * hallucinated commands.
 */
export function assertDidNotInvoke(
  result: SessionResult,
  pattern: RegExp,
  hint: string,
): void {
  const matches = bashMatching(result, pattern);
  if (matches.length > 0) {
    throw new Error(
      [
        `Agent invoked ${pattern} (${hint}) but should not have.`,
        "Offending commands:",
        ...matches.map((c) => `  - ${c.slice(0, 200)}`),
      ].join("\n"),
    );
  }
}
