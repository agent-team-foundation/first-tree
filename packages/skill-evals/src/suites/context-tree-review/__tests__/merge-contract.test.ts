import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..");
const approvedHead = "a".repeat(40);
const otherHead = "b".repeat(40);
const temporaryDirectories: string[] = [];

type TraceEntry = { args: string[]; tool: "first-tree" | "gh" };

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function documentedMergeContract(): string {
  const skill = readFileSync(join(repoRoot, "skills", "context-tree-review", "SKILL.md"), "utf8");
  const match = skill.match(
    /<!-- context-review-merge-contract:start -->\n```sh\n([\s\S]*?)\n```\n<!-- context-review-merge-contract:end -->/u,
  );
  if (!match?.[1]) throw new Error("Missing documented Context Review merge contract.");
  return match[1];
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
}

async function runContract(input: {
  approvalMode?: "invalid" | "success";
  currentHead?: string;
  getMode?: "fail" | "merged" | "open";
  mergeMode?: "fail" | "success";
}): Promise<{ exitCode: number | null; stderr: string; stdout: string; trace: TraceEntry[] }> {
  const root = await mkdtemp(join(tmpdir(), "context-review-merge-contract-"));
  temporaryDirectories.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  const tracePath = join(root, "trace.jsonl");
  const reviewBody = join(root, "review.md");
  await writeFile(reviewBody, "## Approved\n", "utf8");

  await writeExecutable(
    join(bin, "first-tree"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TRACE_PATH, JSON.stringify({ tool: "first-tree", args }) + "\\n");
const reviewedHead = process.env.APPROVAL_MODE === "invalid" ? "not-a-commit" : process.env.APPROVED_HEAD;
process.stdout.write(JSON.stringify({ ok: true, data: { action: "APPROVE", reviewedHead, reviewUrl: "https://github.com/owner/context-tree/pull/42#review" } }) + "\\n");
`,
  );
  await writeExecutable(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TRACE_PATH, JSON.stringify({ tool: "gh", args }) + "\\n");
const methodIndex = args.indexOf("--method");
const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
if (method === "PUT") {
  if (process.env.MERGE_MODE === "success") {
    process.stdout.write(JSON.stringify({ merged: true, message: "Pull Request successfully merged", sha: "c".repeat(40) }) + "\\n");
    process.exit(0);
  }
  process.stderr.write("merge result unconfirmed\\n");
  process.exit(1);
}
if (process.env.GET_MODE === "fail") {
  process.stderr.write("PR state unavailable\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  merged: process.env.GET_MODE === "merged",
  state: process.env.GET_MODE === "merged" ? "closed" : "open",
  head: { sha: process.env.CURRENT_HEAD },
}) + "\\n");
`,
  );

  const result = spawnSync("sh", ["-c", documentedMergeContract()], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      APPROVAL_MODE: input.approvalMode ?? "success",
      APPROVED_HEAD: approvedHead,
      CONTEXT_REVIEW_RUN_ID: "01900000-0000-7000-8000-000000000042",
      CURRENT_HEAD: input.currentHead ?? approvedHead,
      GET_MODE: input.getMode ?? "open",
      MERGE_MODE: input.mergeMode ?? "success",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PR_NUMBER: "42",
      REPOSITORY: "owner/context-tree",
      REVIEW_BODY: reviewBody,
      TRACE_PATH: tracePath,
    },
  });
  const traceText = await readFile(tracePath, "utf8").catch(() => "");
  return {
    exitCode: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
    trace: traceText
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TraceEntry),
  };
}

describe("documented Context Review merge contract", () => {
  it.each([
    {
      expectedGets: 0,
      expectedOutcome: "merged",
      getMode: "open" as const,
      mergeMode: "success" as const,
      name: "merges the unchanged approved head",
    },
    {
      currentHead: otherHead,
      expectedGets: 1,
      expectedOutcome: "open",
      getMode: "open" as const,
      mergeMode: "fail" as const,
      name: "leaves a raced successor head open",
    },
    {
      expectedGets: 1,
      expectedOutcome: "merged",
      getMode: "merged" as const,
      mergeMode: "fail" as const,
      name: "reconciles an unconfirmed delivery once",
    },
    {
      expectedGets: 1,
      expectedOutcome: "unknown",
      getMode: "fail" as const,
      mergeMode: "fail" as const,
      name: "reports unknown when the one reconciliation fails",
    },
  ])("$name", async ({ currentHead, expectedGets, expectedOutcome, getMode, mergeMode }) => {
    const result = await runContract({ currentHead, getMode, mergeMode });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`CONTEXT_REVIEW_MERGE_OUTCOME=${expectedOutcome}`);

    const reviewCalls = result.trace.filter((entry) => entry.tool === "first-tree");
    const githubCalls = result.trace.filter((entry) => entry.tool === "gh");
    const puts = githubCalls.filter((entry) => entry.args.includes("PUT"));
    const gets = githubCalls.filter((entry) => entry.args.includes("GET"));
    expect(reviewCalls).toHaveLength(1);
    expect(puts).toHaveLength(1);
    expect(gets).toHaveLength(expectedGets);
    expect(puts[0]?.args).toEqual([
      "api",
      "--method",
      "PUT",
      "repos/owner/context-tree/pulls/42/merge",
      "--raw-field",
      `sha=${approvedHead}`,
      "--raw-field",
      "merge_method=squash",
    ]);
    expect(githubCalls.every((entry) => entry.args[0] === "api")).toBe(true);
    expect(githubCalls.flatMap((entry) => entry.args)).not.toEqual(expect.arrayContaining(["--admin", "--auto"]));
  });

  it("does not attempt a merge without one valid full reviewedHead in the successful App response", async () => {
    const result = await runContract({ approvalMode: "invalid" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("returned no valid reviewedHead");
    expect(result.trace.filter((entry) => entry.tool === "gh")).toHaveLength(0);
  });
});
