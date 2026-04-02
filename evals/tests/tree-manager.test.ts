/**
 * Unit tests for tree-manager utilities and resolveConditions.
 *
 * Tests pure functions only — no network or subprocess spawning.
 */

import { describe, it, expect } from 'vitest';

import {
  treeBranch,
  treeCommitMessage,
  parseArgs,
  type TreeProvenance,
} from '#evals/scripts/tree-manager.js';
import { resolveConditions } from '#evals/helpers/resolve-conditions.js';
import type { EvalCase } from '#evals/helpers/types.js';

// --- treeBranch ---

describe('treeBranch', () => {
  it('derives branch from org/repo and full SHA', () => {
    expect(treeBranch('HKUDS/nanobot', 'ddc9fc4fd286025aebaab5fb3f2f032a18ed2478'))
      .toBe('nanobot/ddc9fc4f');
  });

  it('handles short SHA', () => {
    expect(treeBranch('org/my-app', 'abc1234'))
      .toBe('my-app/abc1234');
  });

  it('handles repo without org', () => {
    expect(treeBranch('myrepo', 'aabbccdd1122'))
      .toBe('myrepo/aabbccdd');
  });

  it('handles nested org', () => {
    expect(treeBranch('deep/nested/repo', 'abcdef1234567890'))
      .toBe('repo/abcdef12');
  });
});

// --- treeCommitMessage ---

describe('treeCommitMessage', () => {
  const provenance: TreeProvenance = {
    codeRepo: 'HKUDS/nanobot',
    codeCommit: 'ddc9fc4fd286025aebaab5fb3f2f032a18ed2478',
    cliCommit: 'abc123def456',
    cliVersion: '0.0.3',
    model: 'claude-sonnet-4-6',
    timestamp: '2026-04-01T12:00:00Z',
  };

  it('starts with summary line', () => {
    const msg = treeCommitMessage(provenance);
    expect(msg.split('\n')[0]).toBe('Generate tree with context-tree CLI @ abc123d');
  });

  it('includes all provenance fields', () => {
    const msg = treeCommitMessage(provenance);
    expect(msg).toContain('repo: HKUDS/nanobot');
    expect(msg).toContain('code_commit: ddc9fc4fd286025aebaab5fb3f2f032a18ed2478');
    expect(msg).toContain('cli_commit: abc123def456');
    expect(msg).toContain('cli_version: 0.0.3');
    expect(msg).toContain('model: claude-sonnet-4-6');
    expect(msg).toContain('timestamp: 2026-04-01T12:00:00Z');
  });

  it('has blank line after summary', () => {
    const msg = treeCommitMessage(provenance);
    const lines = msg.split('\n');
    expect(lines[1]).toBe('');
  });
});

// --- parseArgs ---

describe('parseArgs', () => {
  it('parses --key value pairs', () => {
    const args = parseArgs(['--repo', 'org/repo', '--commit', 'abc123']);
    expect(args).toEqual({ repo: 'org/repo', commit: 'abc123' });
  });

  it('parses --key=value format', () => {
    const args = parseArgs(['--repo=org/repo', '--commit=abc123']);
    expect(args).toEqual({ repo: 'org/repo', commit: 'abc123' });
  });

  it('handles mixed formats', () => {
    const args = parseArgs(['--repo', 'org/repo', '--commit=abc123', '--model', 'sonnet']);
    expect(args).toEqual({ repo: 'org/repo', commit: 'abc123', model: 'sonnet' });
  });

  it('skips non-flag arguments', () => {
    const args = parseArgs(['positional', '--repo', 'org/repo', 'another']);
    expect(args).toEqual({ repo: 'org/repo' });
  });

  it('returns empty for no args', () => {
    expect(parseArgs([])).toEqual({});
  });

  it('handles flag at end without value', () => {
    // --flag at end with nothing after it: key is not added since next arg doesn't exist
    const args = parseArgs(['--repo', 'org/repo', '--verbose']);
    expect(args).toEqual({ repo: 'org/repo' });
  });

  it('handles hyphenated keys', () => {
    const args = parseArgs(['--tree-repo', 'org/trees', '--cli-version', 'abc']);
    expect(args).toEqual({ 'tree-repo': 'org/trees', 'cli-version': 'abc' });
  });
});

// --- resolveConditions ---

describe('resolveConditions', () => {
  const baseCase: EvalCase = {
    id: 'test',
    source: 'custom',
    repos: [{ repo: 'org/repo', commit_sha: 'abc123' }],
    task: 'Fix bug',
    verification: 'verify.sh',
    difficulty: 'easy',
  };

  it('returns baseline when no env var and no tree versions', () => {
    const original = process.env.EVALS_CONDITIONS;
    delete process.env.EVALS_CONDITIONS;
    try {
      const conditions = resolveConditions(baseCase);
      expect(conditions).toEqual([{ label: 'baseline' }]);
    } finally {
      if (original !== undefined) process.env.EVALS_CONDITIONS = original;
    }
  });

  it('uses case-embedded tree versions when no env var', () => {
    const original = process.env.EVALS_CONDITIONS;
    delete process.env.EVALS_CONDITIONS;
    try {
      const caseWithVersions: EvalCase = {
        ...baseCase,
        context_tree_versions: [
          { label: 'cli-v0.0.3', tree_sha: 'aaa111' },
          { label: 'cli-v0.0.4', tree_sha: 'bbb222' },
        ],
      };
      const conditions = resolveConditions(caseWithVersions);
      expect(conditions).toEqual([
        { label: 'baseline' },
        { label: 'cli-v0.0.3', tree_sha: 'aaa111' },
        { label: 'cli-v0.0.4', tree_sha: 'bbb222' },
      ]);
    } finally {
      if (original !== undefined) process.env.EVALS_CONDITIONS = original;
    }
  });

  it('env var overrides case-embedded versions', () => {
    const original = process.env.EVALS_CONDITIONS;
    process.env.EVALS_CONDITIONS = 'baseline,override:zzz999';
    try {
      const caseWithVersions: EvalCase = {
        ...baseCase,
        context_tree_versions: [
          { label: 'cli-v0.0.3', tree_sha: 'aaa111' },
        ],
      };
      const conditions = resolveConditions(caseWithVersions);
      expect(conditions).toEqual([
        { label: 'baseline' },
        { label: 'override', tree_sha: 'zzz999' },
      ]);
    } finally {
      if (original !== undefined) {
        process.env.EVALS_CONDITIONS = original;
      } else {
        delete process.env.EVALS_CONDITIONS;
      }
    }
  });

  it('handles empty tree versions array', () => {
    const original = process.env.EVALS_CONDITIONS;
    delete process.env.EVALS_CONDITIONS;
    try {
      const caseWithEmpty: EvalCase = {
        ...baseCase,
        context_tree_versions: [],
      };
      const conditions = resolveConditions(caseWithEmpty);
      expect(conditions).toEqual([{ label: 'baseline' }]);
    } finally {
      if (original !== undefined) process.env.EVALS_CONDITIONS = original;
    }
  });
});
