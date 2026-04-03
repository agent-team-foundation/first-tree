/**
 * Generate an HTML report from eval results.
 *
 * Produces a self-contained HTML page with:
 * - Summary comparison table (baseline vs tree conditions)
 * - Per-case detail: token breakdown, per-model costs, turn-by-turn timeline
 */

import type { TrialResult, ModelTokens } from './types.js';

// --- Helpers ---

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function pct(a: number, b: number): string {
  if (b === 0) return '—';
  const d = ((a - b) / b) * 100;
  const sign = d >= 0 ? '+' : '';
  return `${sign}${d.toFixed(0)}%`;
}

function shortenPath(p: string): string {
  return p.replace(/\/tmp\/ct-eval-[^/]+\//, '');
}

// --- Turn extraction (mirrors analyze_eval.py) ---

interface Turn {
  turn: number;
  cacheRead: number;
  cacheCreate: number;
  output: number;
  resultChars: number;
  actions: string[];
  durationSec?: number;
}

function extractTurns(transcript: any[]): Turn[] {
  const turns: Turn[] = [];
  let turnIdx = 0;
  const seen = new Set<string>();
  let lastTimestampMs: number | null = null;

  for (const entry of transcript) {
    if (entry.type === 'assistant') {
      const msg = entry.message || {};
      const usage = msg.usage || {};
      // Deduplicate streaming chunks: use message id, fall back to usage tuple
      const key = msg.id || `${usage.output_tokens || 0}-${usage.cache_creation_input_tokens || 0}-${usage.cache_read_input_tokens || 0}`;
      if (seen.has(key)) continue;
      seen.add(key);

      turnIdx++;
      const turn: Turn = {
        turn: turnIdx,
        cacheRead: usage.cache_read_input_tokens || 0,
        cacheCreate: usage.cache_creation_input_tokens || 0,
        output: usage.output_tokens || 0,
        resultChars: 0,
        actions: [],
      };

      for (const c of (msg.content || [])) {
        if (c.type === 'thinking') {
          const text = (c.thinking || '').slice(0, 80).replace(/\n/g, ' ');
          const tokEst = Math.round((c.thinking || '').length / 4);
          turn.actions.push(`think(${tokEst}tok): ${text}`);
        } else if (c.type === 'text') {
          const text = (c.text || '').slice(0, 60).replace(/\n/g, ' ');
          const tokEst = Math.round((c.text || '').length / 4);
          turn.actions.push(`text(${tokEst}tok): ${text}`);
        } else if (c.type === 'tool_use') {
          const name = c.name || '?';
          const inp = c.input || {};
          if (name === 'Read') {
            const path = shortenPath(inp.file_path || '');
            const off = inp.offset ? `@${inp.offset}` : '';
            const lim = inp.limit ? `:${inp.limit}L` : '';
            turn.actions.push(`Read ${path}${off}${lim}`);
          } else if (name === 'Grep') {
            const pat = (inp.pattern || '').slice(0, 40);
            const path = shortenPath(inp.path || '.');
            turn.actions.push(`Grep '${pat}' in ${path}`);
          } else if (name === 'Glob') {
            turn.actions.push(`Glob '${inp.pattern || ''}'`);
          } else if (name === 'Edit') {
            turn.actions.push(`Edit ${shortenPath(inp.file_path || '')}`);
          } else if (name === 'Bash') {
            turn.actions.push(`Bash: ${(inp.command || '').slice(0, 80)}`);
          } else if (name === 'Write') {
            turn.actions.push(`Write ${shortenPath(inp.file_path || '')}`);
          } else if (name === 'Agent') {
            turn.actions.push(`Agent: ${(inp.description || '').slice(0, 50)}`);
          } else {
            turn.actions.push(name);
          }
        }
      }
      turns.push(turn);
    } else if (entry.type === 'user' && turns.length > 0) {
      for (const c of (entry.message?.content || [])) {
        if (c.type === 'tool_result') {
          const result = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
          turns[turns.length - 1].resultChars += result.length;
        }
      }
      // Compute turn duration from consecutive user timestamps
      if (entry.timestamp) {
        const ts = new Date(entry.timestamp).getTime();
        if (lastTimestampMs !== null) {
          turns[turns.length - 1].durationSec = (ts - lastTimestampMs) / 1000;
        }
        lastTimestampMs = ts;
      }
    }
  }
  return turns;
}

// --- HTML generation ---

function renderSummaryTable(trials: TrialResult[]): string {
  const caseIds = [...new Set(trials.map(t => t.case_id))];
  const conditions = [...new Set(trials.map(t => t.condition))];
  const baselineLabel = conditions.includes('baseline') ? 'baseline' : conditions[0];

  const lookup = new Map<string, TrialResult>();
  for (const t of trials) {
    lookup.set(`${t.case_id}/${t.condition}`, t);
  }

  let html = `<table class="summary">
<thead><tr>
  <th>Case</th><th>Condition</th><th>Pass</th><th>Cost</th><th>Time</th>
  <th>Input Tok</th><th>Output Tok</th><th>Cache Read</th><th>Cache Create</th>
  <th>API Calls</th><th>Cost Delta</th><th>Time Delta</th>
</tr></thead><tbody>`;

  for (const caseId of caseIds) {
    const bl = lookup.get(`${caseId}/${baselineLabel}`);
    for (const cond of conditions) {
      const t = lookup.get(`${caseId}/${cond}`);
      if (!t) continue;
      const isBaseline = cond === baselineLabel;
      const costDelta = bl && !isBaseline ? pct(t.cost_usd, bl.cost_usd) : '—';
      const timeDelta = bl && !isBaseline ? pct(t.wall_clock_ms, bl.wall_clock_ms) : '—';
      const passClass = t.passed ? 'pass' : 'fail';
      const timeDeltaClass = bl && !isBaseline && t.wall_clock_ms < bl.wall_clock_ms ? 'good' : (bl && !isBaseline && t.wall_clock_ms > bl.wall_clock_ms ? 'bad' : '');

      html += `<tr class="${isBaseline ? 'baseline-row' : 'tree-row'}">
  <td>${isBaseline ? esc(caseId) : ''}</td>
  <td>${esc(cond)}</td>
  <td class="${passClass}">${t.passed ? 'PASS' : 'FAIL'}</td>
  <td>$${t.cost_usd.toFixed(2)}</td>
  <td>${Math.round(t.wall_clock_ms / 1000)}s</td>
  <td class="num">${fmt(t.input_tokens)}</td>
  <td class="num">${fmt(t.output_tokens)}</td>
  <td class="num">${fmt(t.cache_read_tokens)}</td>
  <td class="num">${fmt(t.cache_creation_tokens)}</td>
  <td class="num">${t.api_calls}</td>
  <td class="${timeDeltaClass}">${costDelta}</td>
  <td class="${timeDeltaClass}">${timeDelta}</td>
</tr>`;
    }
  }

  html += '</tbody></table>';
  return html;
}

function renderModelBreakdown(trial: TrialResult): string {
  const breakdown = trial.model_breakdown;
  if (!breakdown || breakdown.length <= 1) return '';

  let html = `<h4>Model Breakdown</h4><table class="model-breakdown">
<thead><tr><th>Model</th><th>Cost</th><th>Input</th><th>Output</th><th>Cache Read</th><th>Cache Create</th></tr></thead><tbody>`;

  for (const m of breakdown) {
    html += `<tr>
  <td>${esc(m.model)}</td>
  <td>$${m.costUSD.toFixed(2)}</td>
  <td class="num">${fmt(m.inputTokens)}</td>
  <td class="num">${fmt(m.outputTokens)}</td>
  <td class="num">${fmt(m.cacheReadTokens)}</td>
  <td class="num">${fmt(m.cacheCreationTokens)}</td>
</tr>`;
  }
  html += '</tbody></table>';
  return html;
}

function renderTurnTimeline(trial: TrialResult): string {
  const turns = extractTurns(trial.transcript);
  if (turns.length === 0) return '<p>No turn data available.</p>';

  let html = `<p class="note">Note: "Out*" excludes thinking tokens (not reported per-turn by the API). "Time" is wall time between consecutive tool results (model generation + tool execution).</p>
<table class="turns">
<thead><tr><th>Turn</th><th>Time</th><th>Cache Rd</th><th>Cache Wr</th><th>Out*</th><th>Result</th><th>Actions</th></tr></thead><tbody>`;

  let totalCR = 0, totalCC = 0, totalOut = 0, totalRC = 0, totalTime = 0;

  for (const t of turns) {
    totalCR += t.cacheRead;
    totalCC += t.cacheCreate;
    totalOut += t.output;
    totalRC += t.resultChars;
    if (t.durationSec != null) totalTime += t.durationSec;

    const timeStr = t.durationSec != null ? `${t.durationSec.toFixed(1)}s` : '—';
    const actionsStr = t.actions.map(a => esc(a)).join('<br>');
    html += `<tr>
  <td class="num">${t.turn}</td>
  <td class="num">${timeStr}</td>
  <td class="num">${fmt(t.cacheRead)}</td>
  <td class="num">${fmt(t.cacheCreate)}</td>
  <td class="num">${fmt(t.output)}</td>
  <td class="num">${fmt(t.resultChars)}c</td>
  <td class="actions">${actionsStr}</td>
</tr>`;
  }

  html += `<tr class="total-row">
  <td>SUM</td>
  <td class="num">${totalTime.toFixed(1)}s</td>
  <td class="num">${fmt(totalCR)}</td>
  <td class="num">${fmt(totalCC)}</td>
  <td class="num">${fmt(totalOut)}</td>
  <td class="num">${fmt(totalRC)}c</td>
  <td></td>
</tr>`;

  html += '</tbody></table>';
  return html;
}

function computeThinkingTokens(trial: TrialResult): { thinkingTokens: number; nonThinkingOutput: number } {
  const seen = new Set<string>();
  let nonThinkingOutput = 0;
  for (const entry of trial.transcript) {
    if (entry.type === 'assistant') {
      const msg = entry.message || {};
      const mid = msg.id || '';
      if (seen.has(mid)) continue;
      seen.add(mid);
      nonThinkingOutput += (msg.usage?.output_tokens || 0);
    }
  }
  return {
    thinkingTokens: trial.output_tokens - nonThinkingOutput,
    nonThinkingOutput,
  };
}

function renderTokenSummary(trial: TrialResult): string {
  const { thinkingTokens, nonThinkingOutput } = computeThinkingTokens(trial);
  const thinkPct = trial.output_tokens > 0 ? Math.round((thinkingTokens / trial.output_tokens) * 100) : 0;

  return `<table class="token-summary">
<thead><tr><th>Metric</th><th>Tokens</th><th>Note</th></tr></thead><tbody>
<tr><td>Cache read</td><td class="num">${fmt(trial.cache_read_tokens)}</td><td>0.1x cost weight</td></tr>
<tr><td>Cache create</td><td class="num">${fmt(trial.cache_creation_tokens)}</td><td>1.25x cost weight</td></tr>
<tr><td>Output (total)</td><td class="num">${fmt(trial.output_tokens)}</td><td>5x cost weight</td></tr>
<tr><td>&nbsp;&nbsp;Thinking</td><td class="num">${fmt(thinkingTokens)}</td><td>${thinkPct}% of output</td></tr>
<tr><td>&nbsp;&nbsp;Non-thinking</td><td class="num">${fmt(nonThinkingOutput)}</td><td>tool calls + text</td></tr>
</tbody></table>`;
}

function renderCaseDetail(caseId: string, trials: TrialResult[]): string {
  let html = `<div class="case-detail" id="case-${esc(caseId)}">
<h3>${esc(caseId)}</h3>`;

  for (const t of trials) {
    const passClass = t.passed ? 'pass' : 'fail';
    html += `<div class="condition-detail">
<h4 class="${passClass}">${esc(t.condition)} — ${t.passed ? 'PASS' : 'FAIL'} — $${t.cost_usd.toFixed(2)} — ${Math.round(t.wall_clock_ms / 1000)}s</h4>`;
    html += renderTokenSummary(t);
    html += renderModelBreakdown(t);
    html += '<details><summary>Turn-by-turn timeline</summary>';
    html += renderTurnTimeline(t);
    html += '</details></div>';
  }

  html += '</div>';
  return html;
}

// --- Public API ---

export function generateHtmlReport(
  trials: TrialResult[],
  meta: { model: string; cli: string; branch: string; sha: string; timestamp: string },
): string {
  const caseIds = [...new Set(trials.map(t => t.case_id))];
  const totalCost = trials.reduce((s, t) => s + t.cost_usd, 0);
  const totalPassed = trials.filter(t => t.passed).length;

  let details = '';
  for (const caseId of caseIds) {
    const caseTrials = trials.filter(t => t.case_id === caseId);
    details += renderCaseDetail(caseId, caseTrials);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Eval Report — ${esc(meta.branch)} (${esc(meta.sha)})</title>
<style>
  :root { --bg: #0d1117; --fg: #c9d1d9; --border: #30363d; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --yellow: #d29922; --muted: #8b949e; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--fg); max-width: 1400px; margin: 0 auto; padding: 20px; }
  h1, h2, h3, h4 { color: var(--fg); }
  h1 { border-bottom: 1px solid var(--border); padding-bottom: 8px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 13px; }
  th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
  th { background: #161b22; color: var(--muted); font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .pass { color: var(--green); font-weight: bold; }
  .fail { color: var(--red); font-weight: bold; }
  .good { color: var(--green); }
  .bad { color: var(--red); }
  .baseline-row { background: #161b22; }
  .tree-row { background: #0d1117; }
  .total-row { font-weight: bold; background: #161b22; }
  .actions { font-family: 'SF Mono', SFMono-Regular, Consolas, monospace; font-size: 12px;
    max-width: 600px; word-break: break-all; }
  .case-detail { margin: 24px 0; border: 1px solid var(--border); border-radius: 6px; padding: 16px; }
  .condition-detail { margin: 12px 0; }
  details { margin: 8px 0; }
  summary { cursor: pointer; color: var(--accent); font-weight: 500; }
  .meta { color: var(--muted); font-size: 14px; }
  .note { color: var(--muted); font-size: 12px; font-style: italic; }
  .model-breakdown, .token-summary { width: auto; }
  .model-breakdown td, .model-breakdown th, .token-summary td, .token-summary th { padding: 4px 8px; }
</style>
</head>
<body>
<h1>Eval Report</h1>
<p class="meta">${esc(meta.cli)}/${esc(meta.model)} @ ${esc(meta.branch)} (${esc(meta.sha)}) &mdash; ${esc(meta.timestamp.slice(0, 10))}</p>
<p class="meta">${totalPassed}/${trials.length} passed &mdash; total cost: $${totalCost.toFixed(2)}</p>

<h2>Summary</h2>
${renderSummaryTable(trials)}

<h2>Case Details</h2>
${details}

</body></html>`;
}
