import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const packages = [
  { name: "apps/cli", dir: "apps/cli" },
  { name: "packages/server", dir: "packages/server" },
  { name: "packages/client", dir: "packages/client" },
  { name: "packages/shared", dir: "packages/shared" },
  { name: "packages/web", dir: "packages/web" },
  { name: "packages/github-scan", dir: "packages/github-scan" },
];

const metrics = ["statements", "branches", "functions", "lines"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSummary(summaryPath) {
  const parsed = JSON.parse(readFileSync(summaryPath, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.total)) {
    throw new Error(`${relative(root, summaryPath)} is not a Vitest coverage summary`);
  }

  return parsed.total;
}

function readMetric(summary, metric) {
  const value = summary[metric];
  if (!isRecord(value)) {
    throw new Error(`Coverage summary is missing metric '${metric}'`);
  }

  const total = Number(value.total);
  const covered = Number(value.covered);
  const pct = Number(value.pct);

  if (!Number.isFinite(total) || !Number.isFinite(covered) || !Number.isFinite(pct)) {
    throw new Error(`Coverage metric '${metric}' has invalid totals`);
  }

  return { covered, pct, total };
}

function formatPct(value) {
  return `${value.toFixed(2).padStart(6)}%`;
}

function pctFromCounts(covered, total) {
  if (total === 0) return 100;
  return (covered / total) * 100;
}

const missing = [];
const rows = [];
const totals = new Map(metrics.map((metric) => [metric, { covered: 0, total: 0 }]));

for (const pkg of packages) {
  const summaryPath = resolve(root, pkg.dir, "coverage", "coverage-summary.json");

  if (!existsSync(summaryPath)) {
    missing.push({ name: pkg.name, summaryPath });
    continue;
  }

  const summary = readSummary(summaryPath);
  const metricValues = new Map(metrics.map((metric) => [metric, readMetric(summary, metric)]));

  for (const metric of metrics) {
    const value = metricValues.get(metric);
    if (!value) continue;

    const total = totals.get(metric);
    if (!total) continue;

    total.covered += value.covered;
    total.total += value.total;
  }

  rows.push({
    name: pkg.name,
    html: relative(root, resolve(root, pkg.dir, "coverage", "index.html")),
    metrics: metricValues,
  });
}

if (missing.length > 0) {
  console.error("Coverage summary files are missing. Run `pnpm coverage` first.");
  for (const entry of missing) {
    console.error(`- ${entry.name}: ${relative(root, entry.summaryPath)}`);
  }
  process.exitCode = 1;
} else {
  console.log("Coverage summary");
  console.log("");
  console.log(
    `${"Package".padEnd(23)} ${"Stmts".padStart(8)} ${"Branch".padStart(8)} ${"Funcs".padStart(8)} ${"Lines".padStart(8)}  HTML`,
  );

  for (const row of rows) {
    const values = metrics.map((metric) => {
      const value = row.metrics.get(metric);
      return formatPct(value ? value.pct : 0).padStart(8);
    });
    console.log(`${row.name.padEnd(23)} ${values.join(" ")}  ${row.html}`);
  }

  const totalValues = metrics.map((metric) => {
    const value = totals.get(metric);
    return formatPct(value ? pctFromCounts(value.covered, value.total) : 0).padStart(8);
  });

  console.log(`${"total".padEnd(23)} ${totalValues.join(" ")}  -`);
}
