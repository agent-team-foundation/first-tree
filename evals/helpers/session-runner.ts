/**
 * Agent CLI subprocess runner for eval testing.
 *
 * Spawns an agent CLI (claude, codex, gemini) as an independent process,
 * streams NDJSON output, and returns structured results.
 *
 * Adapted from gstack's session-runner.ts (Bun → Node.js).
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentConfig, SessionResult, CostEstimate, ModelTokens } from '#evals/helpers/types.js';
import { TIMEOUT_SESSION } from '#evals/helpers/timeouts.js';

// --- NDJSON parser (pure, no I/O) ---

export interface ParsedNDJSON {
  transcript: any[];
  resultLine: any | null;
  turnCount: number;
  toolCallCount: number;
  toolCalls: Array<{ tool: string; input: any; output: string }>;
}

export function parseNDJSON(lines: string[]): ParsedNDJSON {
  const transcript: any[] = [];
  let resultLine: any = null;
  let turnCount = 0;
  let toolCallCount = 0;
  const toolCalls: ParsedNDJSON['toolCalls'] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      transcript.push(event);

      if (event.type === 'assistant') {
        turnCount++;
        const content = event.message?.content || [];
        for (const item of content) {
          if (item.type === 'tool_use') {
            toolCallCount++;
            toolCalls.push({
              tool: item.name || 'unknown',
              input: item.input || {},
              output: '',
            });
          }
        }
      }

      if (event.type === 'result') resultLine = event;
    } catch { /* skip malformed lines */ }
  }

  return { transcript, resultLine, turnCount, toolCallCount, toolCalls };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// --- CLI adapter ---

function buildCommand(agent: AgentConfig, maxTurns?: number): { cmd: string; args: string[] } {
  switch (agent.cli) {
    case 'claude-code': {
      const args = [
        '-p',
        '--model', agent.model,
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
      ];
      if (maxTurns != null) {
        args.push('--max-turns', String(maxTurns));
      }
      return { cmd: 'claude', args };
    }
    case 'codex':
      return {
        cmd: 'codex',
        args: [
          'exec',
          '--model', agent.model,
          '--dangerously-auto-approve',
        ],
      };
    case 'gemini':
      return {
        cmd: 'gemini',
        args: [
          '-p',
          '--model', agent.model,
          '--sandbox=false',
        ],
      };
    default:
      throw new Error(`Unknown CLI: ${agent.cli}`);
  }
}

// --- Main runner ---

export async function runSession(options: {
  prompt: string;
  workingDirectory: string;
  agent: AgentConfig;
  maxTurns?: number;
  timeout?: number;
  testName?: string;
}): Promise<SessionResult> {
  const {
    prompt,
    workingDirectory,
    agent,
    maxTurns,
    timeout = TIMEOUT_SESSION,
    testName,
  } = options;

  const startTime = Date.now();

  // Write prompt to temp file to avoid shell escaping issues
  const promptFile = path.join(
    os.tmpdir(),
    `.eval-prompt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(promptFile, prompt);

  const { cmd, args } = buildCommand(agent, maxTurns);

  // If a .venv exists in the working directory, prepend it to PATH
  // so the agent's python/pip commands use the sandboxed environment.
  const env = { ...process.env };
  const venvBin = path.join(workingDirectory, '.venv', 'bin');
  if (fs.existsSync(venvBin)) {
    env.PATH = `${venvBin}:${env.PATH}`;
    env.VIRTUAL_ENV = path.join(workingDirectory, '.venv');
  }

  // Spawn: cat promptfile | <cli> <args>
  const shellCmd = `cat "${promptFile}" | ${cmd} ${args.map(a => `"${a}"`).join(' ')}`;
  const proc = spawn('sh', ['-c', shellCmd], {
    cwd: workingDirectory,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
  }, timeout);

  // Stream NDJSON from stdout
  const collectedLines: string[] = [];
  let liveTurnCount = 0;
  let liveToolCount = 0;
  let firstResponseMs = 0;
  let lastToolTime = 0;
  let maxInterTurnMs = 0;
  let buf = '';

  const stdoutDone = new Promise<void>((resolve) => {
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        collectedLines.push(line);

        try {
          const event = JSON.parse(line);
          if (event.type === 'assistant') {
            liveTurnCount++;
            const content = event.message?.content || [];
            for (const item of content) {
              if (item.type === 'tool_use') {
                liveToolCount++;
                const now = Date.now();
                const elapsed = Math.round((now - startTime) / 1000);

                if (firstResponseMs === 0) firstResponseMs = now - startTime;
                if (lastToolTime > 0) {
                  const interTurn = now - lastToolTime;
                  if (interTurn > maxInterTurnMs) maxInterTurnMs = interTurn;
                }
                lastToolTime = now;

                const progressLine = `  [${elapsed}s] turn ${liveTurnCount} tool #${liveToolCount}: ${item.name}(${truncate(JSON.stringify(item.input || {}), 80)})\n`;
                process.stderr.write(progressLine);
              }
            }
          }
        } catch { /* skip — parseNDJSON handles later */ }
      }
    });

    proc.stdout.on('end', resolve);
  });

  // Collect stderr
  let stderr = '';
  proc.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  // Wait for process exit
  const exitCode = await new Promise<number | null>((resolve) => {
    proc.on('close', (code) => resolve(code));
  });
  await stdoutDone;
  clearTimeout(timeoutId);

  // Flush remaining buffer
  if (buf.trim()) {
    collectedLines.push(buf);
  }

  // Clean up prompt file
  try { fs.unlinkSync(promptFile); } catch { /* non-fatal */ }

  // Determine exit reason
  let exitReason: string;
  if (timedOut) {
    exitReason = 'timeout';
  } else if (exitCode === 0) {
    exitReason = 'success';
  } else {
    exitReason = `exit_code_${exitCode}`;
  }

  const duration = Date.now() - startTime;
  const parsed = parseNDJSON(collectedLines);
  const { transcript, resultLine, toolCalls } = parsed;

  // Refine exit reason from result line (Claude Code specific)
  if (resultLine) {
    if (resultLine.subtype === 'success') {
      exitReason = 'success';
    } else if (resultLine.subtype) {
      exitReason = resultLine.subtype;
    } else if (resultLine.is_error) {
      exitReason = 'error';
    }
  }

  // Extract cost from result line.
  // Aggregate across all models (main agent + subagents like Explorer).
  const turnsUsed = resultLine?.num_turns || 0;
  const rawModelUsage = resultLine?.modelUsage as Record<string, any> | undefined;

  let estimatedCost: number;
  let inputTokens: number;
  let outputTokens: number;
  let cacheCreationTokens: number;
  let cacheReadTokens: number;
  let modelBreakdown: ModelTokens[] | undefined;

  if (rawModelUsage && Object.keys(rawModelUsage).length > 0) {
    // Sum across all models (main + subagents)
    estimatedCost = 0;
    inputTokens = 0;
    outputTokens = 0;
    cacheCreationTokens = 0;
    cacheReadTokens = 0;
    modelBreakdown = [];

    for (const [model, usage] of Object.entries(rawModelUsage)) {
      const mIn = (usage.inputTokens || 0);
      const mOut = (usage.outputTokens || 0);
      const mCC = (usage.cacheCreationInputTokens || 0);
      const mCR = (usage.cacheReadInputTokens || 0);
      const mCost = (usage.costUSD || 0);

      inputTokens += mIn + mCC + mCR;
      outputTokens += mOut;
      cacheCreationTokens += mCC;
      cacheReadTokens += mCR;
      estimatedCost += mCost;

      modelBreakdown.push({
        model,
        inputTokens: mIn + mCC + mCR,
        outputTokens: mOut,
        cacheCreationTokens: mCC,
        cacheReadTokens: mCR,
        costUSD: mCost,
      });
    }
  } else {
    // Fallback to per-turn usage field + total_cost_usd
    estimatedCost = resultLine?.total_cost_usd || 0;
    const usage = resultLine?.usage || {};
    inputTokens = (usage.input_tokens || 0)
      + (usage.cache_creation_input_tokens || 0)
      + (usage.cache_read_input_tokens || 0);
    outputTokens = usage.output_tokens || 0;
    cacheCreationTokens = usage.cache_creation_input_tokens || 0;
    cacheReadTokens = usage.cache_read_input_tokens || 0;
  }

  const costEstimate: CostEstimate = {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    estimatedCost: Math.round(estimatedCost * 100) / 100,
    turnsUsed,
    modelBreakdown,
  };

  if (testName && (exitReason !== 'success')) {
    process.stderr.write(`  ⚠ ${testName}: exit_reason=${exitReason}, turns=${liveTurnCount}, tools=${liveToolCount}\n`);
  }

  return {
    toolCalls,
    exitReason,
    duration,
    output: resultLine?.result || '',
    costEstimate,
    transcript,
    model: agent.model,
    firstResponseMs,
    maxInterTurnMs,
  };
}
