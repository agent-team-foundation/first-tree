/**
 * Load eval case definitions from YAML files in
 * evals/cases/.
 *
 * Supports two YAML formats:
 *   Single-repo:  repo + commit_sha + setup (top-level fields)
 *   Multi-repo:   repos[] array with per-repo fields (P1/P2)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { EvalCase, RepoRef, TreeVersionRef } from '#evals/helpers/types.js';

function parseRepos(data: any, filePath: string): RepoRef[] {
  // Multi-repo format: repos[]
  if (Array.isArray(data.repos)) {
    for (const [i, r] of data.repos.entries()) {
      if (!r.repo || !r.commit_sha) {
        throw new Error(`repos[${i}] missing repo or commit_sha in ${filePath}`);
      }
    }
    return data.repos.map((r: any) => ({
      repo: r.repo,
      commit_sha: r.commit_sha,
      path: r.path,
      setup: r.setup,
    }));
  }

  // Single-repo format: repo + commit_sha at top level
  if (!data.repo || !data.commit_sha) {
    throw new Error(`Missing repo or commit_sha in ${filePath}`);
  }
  return [{
    repo: data.repo,
    commit_sha: data.commit_sha,
    setup: data.setup,
  }];
}

function validateCase(data: any, filePath: string): EvalCase {
  for (const field of ['id', 'source', 'task', 'verification'] as const) {
    if (!data[field]) {
      throw new Error(`Missing required field '${field}' in ${filePath}`);
    }
  }

  if (!['custom', 'swebench'].includes(data.source)) {
    throw new Error(`Invalid source '${data.source}' in ${filePath}. Must be 'custom' or 'swebench'.`);
  }

  if (!['easy', 'medium', 'hard'].includes(data.difficulty || 'medium')) {
    throw new Error(`Invalid difficulty '${data.difficulty}' in ${filePath}.`);
  }

  const repos = parseRepos(data, filePath);

  // Load setup.sh from fixtures if no inline setup on repos
  const fixturesDir = path.resolve(path.dirname(filePath), '..', 'fixtures', data.id);
  const setupShPath = path.join(fixturesDir, 'setup.sh');
  if (repos.length === 1 && !repos[0].setup && fs.existsSync(setupShPath)) {
    repos[0].setup = `bash ${JSON.stringify(setupShPath)}`;
  }

  const context_tree_versions: TreeVersionRef[] | undefined =
    Array.isArray(data.context_tree_versions)
      ? data.context_tree_versions.map((v: any) => ({
          label: String(v.label),
          tree_sha: String(v.tree_sha),
        }))
      : undefined;

  return {
    id: data.id,
    source: data.source,
    repos,
    task: data.task,
    golden_pr: data.golden_pr,
    fix_commit_sha: data.fix_commit_sha,
    verification: data.verification,
    difficulty: data.difficulty || 'medium',
    timeout_ms: data.timeout_ms,
    max_turns: data.max_turns,
    context_tree_versions,
  };
}

export function loadCases(options?: {
  ids?: string[];
  casesDir?: string;
}): EvalCase[] {
  const casesDir = options?.casesDir || path.resolve(import.meta.dirname, '..', 'cases');
  const ids = options?.ids;

  if (!fs.existsSync(casesDir)) {
    throw new Error(`Cases directory not found: ${casesDir}`);
  }

  const files = fs.readdirSync(casesDir)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .filter(f => !f.startsWith('_'))
    .sort();

  const cases: EvalCase[] = [];
  for (const file of files) {
    const filePath = path.join(casesDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = parseYaml(content);
    const evalCase = validateCase(data, filePath);

    if (ids && !ids.includes(evalCase.id)) continue;
    cases.push(evalCase);
  }

  if (cases.length === 0) {
    const msg = ids
      ? `No eval cases found matching ids: ${ids.join(', ')}`
      : `No eval cases found in ${casesDir}`;
    throw new Error(msg);
  }

  return cases;
}
