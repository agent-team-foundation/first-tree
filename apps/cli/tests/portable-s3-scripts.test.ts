import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const UPLOAD_SCRIPT = join(REPO_ROOT, "scripts", "portable", "upload-s3.sh");
const DOWNLOAD_BASE_URL = "https://downloads.example.com/releases";

let tmpDirs: string[] = [];

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  tmpDirs.push(dir);
  return dir;
}

function writeFakeAws(binDir: string, logPath: string): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
node - "$AWS_LOG" "$@" <<'NODE'
const fs = require("node:fs");
const [logPath, ...args] = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
NODE
`,
    { mode: 0o755 },
  );
  writeFileSync(logPath, "");
}

function readAwsCalls(logPath: string): string[][] {
  const content = readFileSync(logPath, "utf8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => {
    const parsed: unknown = JSON.parse(line);
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
      throw new Error(`invalid fake aws log line: ${line}`);
    }
    return parsed;
  });
}

function writeReleaseFixture(
  outDir: string,
  channel: "prod" | "staging",
  version: string,
  downloadBaseUrl = DOWNLOAD_BASE_URL,
): void {
  const packageName = channel === "prod" ? "first-tree" : "first-tree-staging";
  const binName = channel === "prod" ? "first-tree" : "first-tree-staging";
  const aliasName = channel === "prod" ? "ft" : "fts";
  const channelDir = join(outDir, channel);
  const versionDir = join(channelDir, version);
  mkdirSync(versionDir, { recursive: true });
  const fileName = `${packageName}-${version}-linux-x64.tar.gz`;
  const asset = {
    platform: "linux-x64",
    fileName,
    url: `${downloadBaseUrl}/${channel}/${version}/${fileName}`,
    sha256: "a".repeat(64),
    size: 7,
  };
  const metadata = {
    schemaVersion: 1,
    channel,
    version,
    gitSha: "abc123",
    nodeVersion: "v24.0.0",
    packageName,
    binName,
    aliasName,
    generatedAt: "2026-01-01T00:00:00.000Z",
  };
  writeFileSync(join(versionDir, fileName), "payload");
  writeFileSync(join(versionDir, "SHA256SUMS"), `${asset.sha256}  ${fileName}\n`);
  writeFileSync(join(versionDir, "manifest.json"), `${JSON.stringify({ ...metadata, assets: [asset] }, null, 2)}\n`);
  writeFileSync(
    join(channelDir, "latest.json"),
    `${JSON.stringify(
      {
        ...metadata,
        manifestUrl: `${downloadBaseUrl}/${channel}/${version}/manifest.json`,
        assets: [asset],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(channelDir, "install.sh"), "#!/usr/bin/env sh\n", { mode: 0o755 });
}

function runUpload(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stderr: string; stdout: string } {
  return spawnSync("bash", [UPLOAD_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe("portable S3 upload script", () => {
  it("passes S3-compatible endpoint, region, and profile to every aws call", () => {
    const outDir = tempDir("first-tree-portable-s3-");
    const binDir = tempDir("first-tree-portable-aws-");
    const logPath = join(tempDir("first-tree-portable-aws-log-"), "aws.jsonl");
    writeReleaseFixture(outDir, "staging", "1.2.4-staging.7.1");
    writeFakeAws(binDir, logPath);

    const res = runUpload(
      [
        "--channel",
        "staging",
        "--out-dir",
        outDir,
        "--bucket",
        "first-tree-downloads-test",
        "--prefix",
        "releases",
        "--endpoint-url",
        "https://s3.example.com",
        "--region",
        "auto",
        "--profile",
        "portable-test",
        "--dry-run",
      ],
      { ...process.env, AWS_LOG: logPath, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );

    expect(res.status, res.stderr || res.stdout).toBe(0);
    const calls = readAwsCalls(logPath);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.slice(0, 6)).toEqual([
        "--region",
        "auto",
        "--endpoint-url",
        "https://s3.example.com",
        "--profile",
        "portable-test",
      ]);
      expect(call).toContain("--dryrun");
    }
  });

  it("uses immutable cache for version files and no-cache for mutable channel files", () => {
    const outDir = tempDir("first-tree-portable-s3-");
    const binDir = tempDir("first-tree-portable-aws-");
    const logPath = join(tempDir("first-tree-portable-aws-log-"), "aws.jsonl");
    writeReleaseFixture(outDir, "prod", "1.2.3");
    writeFakeAws(binDir, logPath);

    const res = runUpload(
      [
        "--channel",
        "prod",
        "--out-dir",
        outDir,
        "--bucket",
        "first-tree-downloads-test",
        "--prefix",
        "releases",
        "--download-base-url",
        DOWNLOAD_BASE_URL,
        "--dry-run",
      ],
      { ...process.env, AWS_LOG: logPath, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );

    expect(res.status, res.stderr || res.stdout).toBe(0);
    const calls = readAwsCalls(logPath);
    const syncCall = calls.find((call) => call.includes("sync"));
    const cpCalls = calls.filter((call) => call.includes("cp"));
    expect(syncCall).toBeDefined();
    expect(syncCall).toContain("public, max-age=31536000, immutable");
    expect(cpCalls).toHaveLength(2);
    for (const call of cpCalls) {
      expect(call).toContain("no-cache");
    }
  });

  it("uploads prod files under the prod channel prefix", () => {
    const outDir = tempDir("first-tree-portable-s3-");
    const binDir = tempDir("first-tree-portable-aws-");
    const logPath = join(tempDir("first-tree-portable-aws-log-"), "aws.jsonl");
    writeReleaseFixture(outDir, "prod", "1.2.3");
    writeFakeAws(binDir, logPath);

    const res = runUpload(
      [
        "--channel",
        "prod",
        "--out-dir",
        outDir,
        "--bucket",
        "first-tree-downloads-test",
        "--prefix",
        "releases",
        "--dry-run",
      ],
      { ...process.env, AWS_LOG: logPath, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );

    expect(res.status, res.stderr || res.stdout).toBe(0);
    const calls = readAwsCalls(logPath);
    expect(calls.some((call) => call.includes("s3://first-tree-downloads-test/releases/prod/1.2.3/"))).toBe(true);
    expect(calls.some((call) => call.includes("s3://first-tree-downloads-test/releases/prod/latest.json"))).toBe(true);
    expect(calls.some((call) => call.includes("s3://first-tree-downloads-test/releases/staging/latest.json"))).toBe(
      false,
    );
  });

  it("uploads staging files under the staging channel prefix", () => {
    const outDir = tempDir("first-tree-portable-s3-");
    const binDir = tempDir("first-tree-portable-aws-");
    const logPath = join(tempDir("first-tree-portable-aws-log-"), "aws.jsonl");
    writeReleaseFixture(outDir, "staging", "1.2.4-staging.7.1");
    writeFakeAws(binDir, logPath);

    const res = runUpload(
      [
        "--channel",
        "staging",
        "--out-dir",
        outDir,
        "--bucket",
        "first-tree-downloads-test",
        "--prefix",
        "releases",
        "--dry-run",
      ],
      { ...process.env, AWS_LOG: logPath, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );

    expect(res.status, res.stderr || res.stdout).toBe(0);
    const calls = readAwsCalls(logPath);
    expect(
      calls.some((call) => call.includes("s3://first-tree-downloads-test/releases/staging/1.2.4-staging.7.1/")),
    ).toBe(true);
    expect(calls.some((call) => call.includes("s3://first-tree-downloads-test/releases/staging/latest.json"))).toBe(
      true,
    );
    expect(calls.some((call) => call.includes("s3://first-tree-downloads-test/releases/prod/latest.json"))).toBe(false);
  });

  it("verifies public latest, manifest, and tarball URLs after upload", () => {
    const outDir = tempDir("first-tree-portable-s3-");
    const binDir = tempDir("first-tree-portable-aws-");
    const logPath = join(tempDir("first-tree-portable-aws-log-"), "aws.jsonl");
    const publicBaseUrl = pathToFileURL(outDir).href;
    writeReleaseFixture(outDir, "prod", "1.2.3", publicBaseUrl);
    writeFakeAws(binDir, logPath);

    const res = runUpload(
      [
        "--channel",
        "prod",
        "--out-dir",
        outDir,
        "--bucket",
        "first-tree-downloads-test",
        "--prefix",
        "releases",
        "--download-base-url",
        publicBaseUrl,
      ],
      { ...process.env, AWS_LOG: logPath, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );

    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(readAwsCalls(logPath)).toHaveLength(3);
    expect(res.stdout).toContain(`verifying public latest metadata: ${publicBaseUrl}/prod/latest.json`);
    expect(res.stdout).toContain(`verifying public manifest metadata: ${publicBaseUrl}/prod/1.2.3/manifest.json`);
    expect(res.stdout).toContain(
      `verifying public tarball URL: ${publicBaseUrl}/prod/1.2.3/first-tree-1.2.3-linux-x64.tar.gz`,
    );
  });
});
