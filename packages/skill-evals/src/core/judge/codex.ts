import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { appendEvent, isRecord, previewText } from "../events.js";
import type { RunPaths } from "../types.js";
import type { JudgeProvider, JudgeProviderResponse, JudgeRequest } from "./types.js";

const TEXT_KEYS = ["content", "message", "output_text", "text"];

export type CodexJudgeProviderOptions = {
  bin: string;
  eventsPath: string;
  model: string | null;
  paths: RunPaths;
};

function isAssistantMessageRecord(record: Record<string, unknown>): boolean {
  const type = typeof record.type === "string" ? record.type : null;
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

  for (const key of ["item", "message", "response"] as const) {
    const nested = value[key];
    if (isRecord(nested) || Array.isArray(nested)) {
      texts.push(...collectAssistantText(nested));
    }
  }

  const output = value.output;
  if (Array.isArray(output)) {
    texts.push(...collectAssistantText(output));
  }

  return texts;
}

function codexArgs(request: JudgeRequest, model: string | null, paths: RunPaths): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--cd",
    paths.runRoot,
    "-c",
    "shell_environment_policy.inherit=none",
  ];

  if (model !== null) {
    args.push("--model", model);
  }

  args.push(request.prompt);
  return args;
}

function createJudgeCommandGuards(paths: RunPaths): void {
  mkdirSync(paths.binDir, { recursive: true });
  const script = `#!/bin/sh
printf '[first-tree-skill-evals] judge external command blocked: %s\\n' "$0 $*" >&2
exit 64
`;
  for (const command of ["curl", "first-tree", "first-tree-staging", "gh", "git", "wget"]) {
    const shimPath = join(paths.binDir, command);
    writeFileSync(shimPath, script, "utf8");
    chmodSync(shimPath, 0o755);
  }
}

async function waitForExit(
  child: ReturnType<typeof spawn>,
  eventsPath: string,
): Promise<{ exitCode: number; spawnError: string | null }> {
  return await new Promise((resolve) => {
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      appendEvent(eventsPath, {
        error: error.message,
        type: "judge_codex_spawn_error",
      });
      resolve({ exitCode: 127, spawnError: error.message });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: code ?? 1, spawnError: null });
    });
  });
}

export function createCodexJudgeProvider(options: CodexJudgeProviderOptions): JudgeProvider {
  return {
    async judge(request: JudgeRequest): Promise<JudgeProviderResponse> {
      const startedAt = Date.now();
      const args = codexArgs(request, options.model, options.paths);
      const assistantTexts: string[] = [];
      createJudgeCommandGuards(options.paths);

      appendEvent(options.eventsPath, {
        args,
        caseId: request.caseId,
        model: options.model,
        type: "judge_codex_started",
      });

      const child = spawn(options.bin, args, {
        cwd: options.paths.runRoot,
        env: {
          ...process.env,
          FIRST_TREE_EVAL_CASE_ID: request.caseId,
          FIRST_TREE_EVAL_EVENTS: options.eventsPath,
          FIRST_TREE_EVAL_PHASE: "judge",
          PATH: `${options.paths.binDir}:${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdoutTask = (async (): Promise<void> => {
        if (!child.stdout) return;
        const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: child.stdout });
        for await (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            appendEvent(options.eventsPath, {
              event,
              type: "judge_codex_event",
            });
            assistantTexts.push(...collectAssistantText(event));
          } catch {
            appendEvent(options.eventsPath, {
              linePreview: previewText(line),
              type: "judge_codex_stdout",
            });
          }
        }
      })();

      const stderrTask = (async (): Promise<void> => {
        if (!child.stderr) return;
        const lines = createInterface({ crlfDelay: Number.POSITIVE_INFINITY, input: child.stderr });
        for await (const line of lines) {
          if (!line.trim()) continue;
          appendEvent(options.eventsPath, {
            linePreview: previewText(line),
            type: "judge_codex_stderr",
          });
        }
      })();

      const { exitCode, spawnError } = await waitForExit(child, options.eventsPath);
      await Promise.all([stdoutTask, stderrTask]);

      const durationMs = Date.now() - startedAt;
      appendEvent(options.eventsPath, {
        caseId: request.caseId,
        durationMs,
        exitCode,
        type: "judge_codex_finished",
      });

      if (spawnError !== null) {
        throw new Error(`codex judge spawn error: ${spawnError}. See ${options.eventsPath}.`);
      }
      if (exitCode !== 0) {
        throw new Error(`codex judge exited ${exitCode}. See ${options.eventsPath}.`);
      }

      const rawOutput = assistantTexts.at(-1)?.trim() ?? "";
      if (!rawOutput) {
        throw new Error(`codex judge did not produce assistant JSON output. See ${options.eventsPath}.`);
      }

      return {
        cost_usd: null,
        duration_ms: durationMs,
        judge_model: options.model ?? "codex-default",
        provider: "codex",
        raw_output: rawOutput,
      };
    },
  };
}
