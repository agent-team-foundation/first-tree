/**
 * Unit tests for eval harness helpers.
 *
 * Tests pure functions and data loading — no subprocess spawning.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseNDJSON } from '#evals/helpers/session-runner.js';
import { loadCases } from '#evals/helpers/case-loader.js';
import { parseConditions } from '#evals/helpers/parse-conditions.js';
import { EvalCollector } from '#evals/helpers/eval-store.js';

// --- Temp dir helper ---

let tmpDirs: string[] = [];

function useTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eval-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

function writeCase(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content);
}

// --- parseNDJSON ---

describe('parseNDJSON', () => {
  it('parses empty input', () => {
    const result = parseNDJSON([]);
    expect(result.transcript).toEqual([]);
    expect(result.resultLine).toBeNull();
    expect(result.turnCount).toBe(0);
    expect(result.toolCallCount).toBe(0);
    expect(result.toolCalls).toEqual([]);
  });

  it('skips blank lines', () => {
    const result = parseNDJSON(['', '  ', '\t']);
    expect(result.transcript).toEqual([]);
  });

  it('skips malformed JSON', () => {
    const result = parseNDJSON(['not json', '{ broken']);
    expect(result.transcript).toEqual([]);
  });

  it('counts turns from assistant events', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
    ];
    const result = parseNDJSON(lines);
    expect(result.turnCount).toBe(3);
    expect(result.toolCallCount).toBe(0);
  });

  it('extracts tool calls from assistant events', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/foo.ts' } },
            { type: 'text', text: 'hello' },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/bar.ts' } },
          ],
        },
      }),
    ];
    const result = parseNDJSON(lines);
    expect(result.turnCount).toBe(1);
    expect(result.toolCallCount).toBe(2);
    expect(result.toolCalls).toEqual([
      { tool: 'Read', input: { file_path: '/foo.ts' }, output: '' },
      { tool: 'Edit', input: { file_path: '/bar.ts' }, output: '' },
    ]);
  });

  it('captures result line', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.15,
        num_turns: 5,
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 1000,
        },
      }),
    ];
    const result = parseNDJSON(lines);
    expect(result.resultLine).not.toBeNull();
    expect(result.resultLine.type).toBe('result');
    expect(result.resultLine.total_cost_usd).toBe(0.15);
    expect(result.resultLine.usage.input_tokens).toBe(100);
    expect(result.resultLine.usage.cache_read_input_tokens).toBe(5000);
  });

  it('handles tool_use with missing name', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use' }] },
      }),
    ];
    const result = parseNDJSON(lines);
    expect(result.toolCalls[0].tool).toBe('unknown');
  });
});

// --- parseConditions ---

describe('parseConditions', () => {
  it('parses baseline only', () => {
    const conditions = parseConditions('baseline');
    expect(conditions).toEqual([{ label: 'baseline' }]);
  });

  it('parses multiple conditions with tree SHAs', () => {
    const conditions = parseConditions('baseline,cli-v1:aaa111,human:bbb222');
    expect(conditions).toEqual([
      { label: 'baseline' },
      { label: 'cli-v1', tree_sha: 'aaa111' },
      { label: 'human', tree_sha: 'bbb222' },
    ]);
  });

  it('trims whitespace', () => {
    const conditions = parseConditions(' baseline , cli-v1:aaa111 ');
    expect(conditions).toEqual([
      { label: 'baseline' },
      { label: 'cli-v1', tree_sha: 'aaa111' },
    ]);
  });

  it('handles SHA with colons (long SHA)', () => {
    // Only the first colon splits label from SHA
    const conditions = parseConditions('test:abc:def');
    expect(conditions).toEqual([
      { label: 'test', tree_sha: 'abc:def' },
    ]);
  });
});

// --- loadCases ---

describe('loadCases', () => {
  it('loads a single-repo case from YAML', () => {
    const dir = useTmpDir();
    writeCase(dir, 'test.yaml', `
id: test-case
source: custom
repo: org/repo
commit_sha: "abc123"
task: "Fix the bug"
verification: verify.sh
difficulty: easy
`);

    const cases = loadCases({ casesDir: dir });
    expect(cases).toHaveLength(1);
    expect(cases[0].id).toBe('test-case');
    expect(cases[0].repos).toEqual([
      { repo: 'org/repo', commit_sha: 'abc123', setup: undefined },
    ]);
  });

  it('loads a multi-repo case from YAML', () => {
    const dir = useTmpDir();
    writeCase(dir, 'multi.yaml', `
id: multi-case
source: custom
repos:
  - repo: org/backend
    commit_sha: "aaa111"
    path: backend
    setup: "pip install -e ."
  - repo: org/frontend
    commit_sha: "bbb222"
    path: web
task: "Fix the flow"
verification: verify.sh
difficulty: hard
`);

    const cases = loadCases({ casesDir: dir });
    expect(cases).toHaveLength(1);
    expect(cases[0].repos).toHaveLength(2);
    expect(cases[0].repos[0]).toEqual({
      repo: 'org/backend',
      commit_sha: 'aaa111',
      path: 'backend',
      setup: 'pip install -e .',
    });
    expect(cases[0].repos[1]).toEqual({
      repo: 'org/frontend',
      commit_sha: 'bbb222',
      path: 'web',
      setup: undefined,
    });
  });

  it('skips files starting with _', () => {
    const dir = useTmpDir();
    writeCase(dir, '_example.yaml', `
id: example
source: custom
repo: org/repo
commit_sha: "abc"
task: "example"
verification: verify.sh
`);

    expect(() => loadCases({ casesDir: dir })).toThrow('No eval cases found');
  });

  it('filters by case id', () => {
    const dir = useTmpDir();
    writeCase(dir, 'a.yaml', `
id: case-a
source: custom
repo: org/a
commit_sha: "aaa"
task: "task a"
verification: verify.sh
`);
    writeCase(dir, 'b.yaml', `
id: case-b
source: custom
repo: org/b
commit_sha: "bbb"
task: "task b"
verification: verify.sh
`);

    const cases = loadCases({ casesDir: dir, ids: ['case-b'] });
    expect(cases).toHaveLength(1);
    expect(cases[0].id).toBe('case-b');
  });

  it('throws on missing required fields', () => {
    const dir = useTmpDir();
    writeCase(dir, 'bad.yaml', `
id: bad-case
source: custom
task: "no repo"
verification: verify.sh
`);

    expect(() => loadCases({ casesDir: dir })).toThrow('Missing repo or commit_sha');
  });

  it('throws on invalid source', () => {
    const dir = useTmpDir();
    writeCase(dir, 'bad.yaml', `
id: bad-case
source: invalid
repo: org/repo
commit_sha: "abc"
task: "test"
verification: verify.sh
`);

    expect(() => loadCases({ casesDir: dir })).toThrow("Invalid source");
  });

  it('throws on missing cases directory', () => {
    expect(() => loadCases({ casesDir: '/nonexistent' })).toThrow('Cases directory not found');
  });

  it('defaults difficulty to medium', () => {
    const dir = useTmpDir();
    writeCase(dir, 'test.yaml', `
id: test
source: custom
repo: org/repo
commit_sha: "abc"
task: "test"
verification: verify.sh
`);

    const cases = loadCases({ casesDir: dir });
    expect(cases[0].difficulty).toBe('medium');
  });

  it('preserves optional fields', () => {
    const dir = useTmpDir();
    writeCase(dir, 'test.yaml', `
id: test
source: custom
repo: org/repo
commit_sha: "abc"
task: "test"
verification: verify.sh
golden_pr: golden.patch
timeout_ms: 120000
max_turns: 10
`);

    const cases = loadCases({ casesDir: dir });
    expect(cases[0].golden_pr).toBe('golden.patch');
    expect(cases[0].timeout_ms).toBe(120000);
    expect(cases[0].max_turns).toBe(10);
  });
});

// --- EvalCollector ---

describe('EvalCollector', () => {
  it('accumulates trials and finalizes', async () => {
    const evalDir = useTmpDir();
    const collector = new EvalCollector({
      model: 'test-model',
      cli: 'claude-code',
      evalDir,
    });

    collector.addTrial({
      case_id: 'test-case',
      condition: 'baseline',
      trial: 1,
      passed: true,
      tests_total: 2,
      tests_passed: 2,
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_tokens: 500,
      cache_read_tokens: 300,
      api_calls: 5,
      wall_clock_ms: 10000,
      cost_usd: 0.05,
      exit_reason: 'success',
      transcript: [],
      model: 'test-model',
      cli: 'claude-code',
    });

    collector.addTrial({
      case_id: 'test-case',
      condition: 'cli-v1',
      trial: 1,
      passed: false,
      tests_total: 2,
      tests_passed: 1,
      input_tokens: 2000,
      output_tokens: 400,
      cache_creation_tokens: 1000,
      cache_read_tokens: 600,
      api_calls: 8,
      wall_clock_ms: 20000,
      cost_usd: 0.10,
      exit_reason: 'success',
      transcript: [],
      model: 'test-model',
      cli: 'claude-code',
    });

    const filepath = await collector.finalize();
    expect(filepath).toContain('.json');

    // Read the output file
    const { readFileSync } = await import('node:fs');
    const data = JSON.parse(readFileSync(filepath, 'utf-8'));

    expect(data.schema_version).toBe(1);
    expect(data.model).toBe('test-model');
    expect(data.cli).toBe('claude-code');
    expect(data.trials).toHaveLength(2);
    expect(data.total_cost_usd).toBe(0.15);
    expect(data.conditions).toEqual(expect.arrayContaining(['baseline', 'cli-v1']));
  });

  it('writes partial file after each trial', () => {
    const evalDir = useTmpDir();
    const collector = new EvalCollector({
      model: 'test-model',
      cli: 'claude-code',
      evalDir,
    });

    collector.addTrial({
      case_id: 'test',
      condition: 'baseline',
      trial: 1,
      passed: true,
      tests_total: 1,
      tests_passed: 1,
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      api_calls: 1,
      wall_clock_ms: 5000,
      cost_usd: 0.01,
      exit_reason: 'success',
      transcript: [],
      model: 'test-model',
      cli: 'claude-code',
    });

    const { existsSync, readFileSync } = require('node:fs');
    const partialPath = join(evalDir, '_partial-eval.json');
    expect(existsSync(partialPath)).toBe(true);

    const partial = JSON.parse(readFileSync(partialPath, 'utf-8'));
    expect(partial._partial).toBe(true);
    expect(partial.trials).toHaveLength(1);
  });

  it('finalize is idempotent', async () => {
    const evalDir = useTmpDir();
    const collector = new EvalCollector({
      model: 'test-model',
      cli: 'claude-code',
      evalDir,
    });

    const path1 = await collector.finalize();
    const path2 = await collector.finalize();
    expect(path1).not.toBe('');
    expect(path2).toBe('');
  });
});
