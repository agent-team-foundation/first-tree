#!/usr/bin/env npx tsx
/**
 * Aggregate multiple eval result JSON files into a single HTML report.
 *
 * Usage:
 *   npx tsx evals/scripts/aggregate-report.ts file1.json file2.json ...
 *   npx tsx evals/scripts/aggregate-report.ts ~/.context-tree/evals/feat-eval-phase1-2026-04-03-05*.json
 *
 * Outputs an HTML file to the same directory as the first input file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TrialResult, EvalRun } from '../helpers/types.js';
import { generateHtmlReport } from '../helpers/html-report.js';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: aggregate-report.ts <file1.json> [file2.json] ...');
  process.exit(1);
}

const allTrials: TrialResult[] = [];
let model = '';
let cli = '';
let branch = '';
let sha = '';
let timestamp = '';

for (const file of files) {
  const data: EvalRun = JSON.parse(fs.readFileSync(file, 'utf-8'));
  allTrials.push(...data.trials);
  // Use metadata from the first file
  if (!model) {
    model = data.model;
    cli = data.cli;
    branch = data.branch;
    sha = data.git_sha;
    timestamp = data.timestamp;
  }
}

console.log(`Loaded ${allTrials.length} trials from ${files.length} files`);
console.log(`Cases: ${[...new Set(allTrials.map(t => t.case_id))].join(', ')}`);
console.log(`Conditions: ${[...new Set(allTrials.map(t => t.condition))].join(', ')}`);

const html = generateHtmlReport(allTrials, { model, cli, branch, sha, timestamp });

const outDir = path.dirname(files[0]);
const outFile = path.join(outDir, `eval-report-${timestamp.slice(0, 10)}.html`);
fs.writeFileSync(outFile, html);
console.log(`Report written to: ${outFile}`);
