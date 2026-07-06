import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const UPLOAD_SCRIPT = join(REPO_ROOT, "scripts", "portable", "upload-s3.sh");
const DOWNLOAD_BASE_URL = "https://downloads.example.com/releases";

type Channel = "prod" | "staging";
type AwsObjectState = {
  size: number;
  metadata: Record<string, string>;
  cacheControl?: string;
  contentType?: string;
  bodySha256?: string;
};
type AwsState = { objects: Record<string, AwsObjectState> };

let tmpDirs: string[] = [];

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  tmpDirs.push(dir);
  return dir;
}

function sha256Bytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

function s3Key(prefix: string, key: string): string {
  return prefix ? `${prefix}/${key}` : key;
}

function writeFakeAws(binDir: string, logPath: string): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "aws"),
    `#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");

const args = process.argv.slice(2);
fs.appendFileSync(process.env.AWS_LOG, JSON.stringify(args) + "\\n");

const serviceIndex = args.findIndex((arg) => arg === "s3api" || arg === "s3");
if (serviceIndex === -1) process.exit(0);
const service = args[serviceIndex];
const command = args[serviceIndex + 1];
const rest = args.slice(serviceIndex + 2);

function option(name) {
  const index = rest.indexOf(name);
  return index === -1 ? undefined : rest[index + 1];
}

function hasOption(name) {
  return rest.includes(name);
}

function readState() {
  if (!process.env.AWS_STATE || !fs.existsSync(process.env.AWS_STATE)) return { objects: {} };
  return JSON.parse(fs.readFileSync(process.env.AWS_STATE, "utf8"));
}

function writeState(state) {
  if (!process.env.AWS_STATE) return;
  fs.writeFileSync(process.env.AWS_STATE, JSON.stringify(state, null, 2));
}

function parseMetadata(value) {
  if (!value) return {};
  const metadata = {};
  for (const part of value.split(",")) {
    const [key, ...restValue] = part.split("=");
    if (key) metadata[key] = restValue.join("=");
  }
  return metadata;
}

if (service === "s3" && command === "cp") {
  process.exit(0);
}

if (service !== "s3api") {
  process.stderr.write("unsupported service: " + service + "\\n");
  process.exit(2);
}

const state = readState();

if (command === "list-objects-v2") {
  const prefix = option("--prefix") || "";
  const contents = Object.entries(state.objects)
    .filter(([key]) => key.startsWith(prefix))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([Key, object]) => ({ Key, Size: object.size }));
  process.stdout.write(JSON.stringify({ Contents: contents }));
  process.exit(0);
}

if (command === "head-object") {
  const key = option("--key");
  const object = key ? state.objects[key] : undefined;
  if (!object) {
    process.stderr.write("Not Found\\n");
    process.exit(254);
  }
  process.stdout.write(JSON.stringify({ ContentLength: object.size, Metadata: object.metadata || {} }));
  process.exit(0);
}

if (command === "put-object") {
  const key = option("--key");
  const body = option("--body");
  if (!key || !body) {
    process.stderr.write("put-object requires --key and --body\\n");
    process.exit(2);
  }
  if (hasOption("--if-none-match") && state.objects[key]) {
    process.stderr.write("PreconditionFailed\\n");
    process.exit(255);
  }
  const payload = fs.readFileSync(body);
  const bodySha256 = crypto.createHash("sha256").update(payload).digest("hex");
  state.objects[key] = {
    size: payload.length,
    metadata: parseMetadata(option("--metadata")),
    cacheControl: option("--cache-control"),
    contentType: option("--content-type"),
    bodySha256,
  };
  writeState(state);
  process.stdout.write(JSON.stringify({ ETag: JSON.stringify(bodySha256) }));
  process.exit(0);
}

process.stderr.write("unsupported s3api command: " + command + "\\n");
process.exit(2);
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

function serviceArgs(call: string[]): string[] {
  const index = call.findIndex((arg) => arg === "s3api" || arg === "s3");
  return index === -1 ? [] : call.slice(index);
}

function optionValue(call: string[], name: string): string | undefined {
  const index = call.indexOf(name);
  return index === -1 ? undefined : call[index + 1];
}

function putObjectCalls(calls: string[][]): string[][] {
  return calls.filter((call) => {
    const args = serviceArgs(call);
    return args[0] === "s3api" && args[1] === "put-object";
  });
}

function putObjectKeys(calls: string[][]): string[] {
  return putObjectCalls(calls)
    .map((call) => optionValue(call, "--key"))
    .filter((key): key is string => typeof key === "string");
}

function writeState(statePath: string, state: AwsState = { objects: {} }): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function readState(statePath: string): AwsState {
  return JSON.parse(readFileSync(statePath, "utf8")) as AwsState;
}

function writeReleaseFixture(
  outDir: string,
  channel: Channel,
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
  const payload = Buffer.from(`payload for ${fileName}\n`);
  const asset = {
    platform: "linux-x64",
    fileName,
    url: `${downloadBaseUrl}/${channel}/${version}/${fileName}`,
    sha256: sha256Bytes(payload),
    size: payload.length,
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
  writeFileSync(join(versionDir, fileName), payload);
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

function immutableFixtureFiles(outDir: string, channel: Channel, version: string): string[] {
  const versionDir = join(outDir, channel, version);
  const manifest = JSON.parse(readFileSync(join(versionDir, "manifest.json"), "utf8")) as {
    assets: Array<{ fileName: string }>;
  };
  return ["manifest.json", "SHA256SUMS", ...manifest.assets.map((asset) => asset.fileName)];
}

function seedImmutableObjects(
  statePath: string,
  outDir: string,
  channel: Channel,
  version: string,
  prefix = "releases",
  fileNames = immutableFixtureFiles(outDir, channel, version),
): void {
  const state = readState(statePath);
  const versionDir = join(outDir, channel, version);
  for (const fileName of fileNames) {
    const localPath = join(versionDir, fileName);
    state.objects[s3Key(prefix, `${channel}/${version}/${fileName}`)] = {
      size: statSync(localPath).size,
      metadata: { sha256: sha256File(localPath) },
      cacheControl: "public, max-age=31536000, immutable",
      contentType: fileName.endsWith(".tar.gz") ? "application/gzip" : "application/octet-stream",
      bodySha256: sha256File(localPath),
    };
  }
  writeState(statePath, state);
}

function runUpload(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stderr: string; stdout: string } {
  return spawnSync("bash", [UPLOAD_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
  });
}

function fakeAwsEnv(binDir: string, logPath: string, statePath: string): NodeJS.ProcessEnv {
  return { ...process.env, AWS_LOG: logPath, AWS_STATE: statePath, PATH: `${binDir}:${process.env.PATH ?? ""}` };
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe("portable S3 upload script", () => {
  it("fresh prefix uploads immutable objects with conditional put-object before mutable pointers", () => {
    const outDir = tempDir("first-tree-portable-s3-");
    const binDir = tempDir("first-tree-portable-aws-");
    const logPath = join(tempDir("first-tree-portable-aws-log-"), "aws.jsonl");
    const statePath = join(tempDir("first-tree-portable-aws-state-"), "state.json");
    const publicBaseUrl = pathToFileURL(outDir).href;
    writeReleaseFixture(outDir, "prod", "1.2.3", publicBaseUrl);
    writeState(statePath);
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
      fakeAwsEnv(binDir, logPath, statePath),
    );

    expect(res.status, res.stderr || res.stdout).toBe(0);
    const calls = readAwsCalls(logPath);
    expect(calls.some((call) => call.includes("sync"))).toBe(false);
    const keys = putObjectKeys(calls);
    expect(keys.filter((key) => key.startsWith("releases/prod/1.2.3/"))).toHaveLength(3);
    expect(keys).toContain("releases/prod/latest.json");
    expect(keys).toContain("releases/prod/install.sh");
    for (const call of putObjectCalls(calls).filter((call) =>
      optionValue(call, "--key")?.startsWith("releases/prod/1.2.3/"),
    )) {
      expect(call).toContain("--if-none-match");
      expect(call).toContain("*");
      expect(call).toContain("public, max-age=31536000, immutable");
    }
    const firstMutableIndex = calls.findIndex((call) => optionValue(call, "--key") === "releases/prod/latest.json");
    const lastImmutableIndex = Math.max(
      ...calls
        .map((call, index) => ({ key: optionValue(call, "--key"), index }))
        .filter((item) => item.key?.startsWith("releases/prod/1.2.3/"))
        .map((item) => item.index),
    );
    expect(firstMutableIndex).toBeGreaterThan(lastImmutableIndex);
    expect(Object.keys(readState(statePath).objects).sort()).toEqual([
      "releases/prod/1.2.3/SHA256SUMS",
      "releases/prod/1.2.3/first-tree-1.2.3-linux-x64.tar.gz",
      "releases/prod/1.2.3/manifest.json",
      "releases/prod/install.sh",
      "releases/prod/latest.json",
    ]);
  });

  it("complete identical prefix skips immutable upload and refreshes mutable pointers", () => {
    const outDir = tempDir("first-tree-portable-s3-");
    const binDir = tempDir("first-tree-portable-aws-");
    const logPath = join(tempDir("first-tree-portable-aws-log-"), "aws.jsonl");
    const statePath = join(tempDir("first-tree-portable-aws-state-"), "state.json");
    const publicBaseUrl = pathToFileURL(outDir).href;
    writeReleaseFixture(outDir, "prod", "1.2.3", publicBaseUrl);
    writeState(statePath);
    seedImmutableObjects(statePath, outDir, "prod", "1.2.3");
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
      fakeAwsEnv(binDir, logPath, statePath),
    );

    expect(res.status, res.stderr || res.stdout).toBe(0);
    const keys = putObjectKeys(readAwsCalls(logPath));
    expect(keys.filter((key) => key.startsWith("releases/prod/1.2.3/"))).toEqual([]);
    expect(keys.sort()).toEqual(["releases/prod/install.sh", "releases/prod/latest.json"]);
  });

  it("partial identical prefix uploads only missing immutable objects", () => {
    const outDir = tempDir("first-tree-portable-s3-");
    const binDir = tempDir("first-tree-portable-aws-");
    const logPath = join(tempDir("first-tree-portable-aws-log-"), "aws.jsonl");
    const statePath = join(tempDir("first-tree-portable-aws-state-"), "state.json");
    const publicBaseUrl = pathToFileURL(outDir).href;
    writeReleaseFixture(outDir, "prod", "1.2.3", publicBaseUrl);
    writeState(statePath);
    seedImmutableObjects(statePath, outDir, "prod", "1.2.3", "releases", ["manifest.json"]);
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
      fakeAwsEnv(binDir, logPath, statePath),
    );

    expect(res.status, res.stderr || res.stdout).toBe(0);
    const immutableKeys = putObjectKeys(readAwsCalls(logPath)).filter((key) => key.startsWith("releases/prod/1.2.3/"));
    expect(immutableKeys.sort()).toEqual([
      "releases/prod/1.2.3/SHA256SUMS",
      "releases/prod/1.2.3/first-tree-1.2.3-linux-x64.tar.gz",
    ]);
  });

  it("fails on mismatched remote immutable objects before mutable pointer updates", () => {
    const outDir = tempDir("first-tree-portable-s3-");
    const binDir = tempDir("first-tree-portable-aws-");
    const logPath = join(tempDir("first-tree-portable-aws-log-"), "aws.jsonl");
    const statePath = join(tempDir("first-tree-portable-aws-state-"), "state.json");
    const publicBaseUrl = pathToFileURL(outDir).href;
    writeReleaseFixture(outDir, "prod", "1.2.3", publicBaseUrl);
    writeState(statePath);
    seedImmutableObjects(statePath, outDir, "prod", "1.2.3");
    const state = readState(statePath);
    state.objects["releases/prod/1.2.3/manifest.json"].metadata.sha256 = "0".repeat(64);
    writeState(statePath, state);
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
      fakeAwsEnv(binDir, logPath, statePath),
    );

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("sha256 metadata mismatch");
    expect(putObjectKeys(readAwsCalls(logPath)).some((key) => key === "releases/prod/latest.json")).toBe(false);
  });

  it("fails on extra remote version objects before mutable pointer updates", () => {
    const outDir = tempDir("first-tree-portable-s3-");
    const binDir = tempDir("first-tree-portable-aws-");
    const logPath = join(tempDir("first-tree-portable-aws-log-"), "aws.jsonl");
    const statePath = join(tempDir("first-tree-portable-aws-state-"), "state.json");
    const publicBaseUrl = pathToFileURL(outDir).href;
    writeReleaseFixture(outDir, "prod", "1.2.3", publicBaseUrl);
    writeState(statePath, {
      objects: {
        "releases/prod/1.2.3/extra.txt": { size: 5, metadata: { sha256: "1".repeat(64) } },
      },
    });
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
      fakeAwsEnv(binDir, logPath, statePath),
    );

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("unexpected object");
    expect(putObjectKeys(readAwsCalls(logPath))).toEqual([]);
  });

  it("preflight-only checks compatibility without final writes", () => {
    const outDir = tempDir("first-tree-portable-s3-");
    const binDir = tempDir("first-tree-portable-aws-");
    const logPath = join(tempDir("first-tree-portable-aws-log-"), "aws.jsonl");
    const statePath = join(tempDir("first-tree-portable-aws-state-"), "state.json");
    writeReleaseFixture(outDir, "staging", "1.2.4-staging.7.1");
    writeState(statePath);
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
        "--download-base-url",
        DOWNLOAD_BASE_URL,
        "--preflight-only",
      ],
      fakeAwsEnv(binDir, logPath, statePath),
    );

    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(putObjectKeys(readAwsCalls(logPath))).toEqual([]);
    expect(Object.keys(readState(statePath).objects)).toEqual([]);
  });

  it("preflight-only detects immutable conflicts without writing", () => {
    const outDir = tempDir("first-tree-portable-s3-");
    const binDir = tempDir("first-tree-portable-aws-");
    const logPath = join(tempDir("first-tree-portable-aws-log-"), "aws.jsonl");
    const statePath = join(tempDir("first-tree-portable-aws-state-"), "state.json");
    writeReleaseFixture(outDir, "staging", "1.2.4-staging.7.1");
    writeState(statePath);
    seedImmutableObjects(statePath, outDir, "staging", "1.2.4-staging.7.1");
    const state = readState(statePath);
    state.objects["releases/staging/1.2.4-staging.7.1/SHA256SUMS"].size += 1;
    writeState(statePath, state);
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
        "--download-base-url",
        DOWNLOAD_BASE_URL,
        "--preflight-only",
      ],
      fakeAwsEnv(binDir, logPath, statePath),
    );

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("size mismatch");
    expect(putObjectKeys(readAwsCalls(logPath))).toEqual([]);
  });

  it("dry-run stays offline-compatible while preserving aws global options", () => {
    const outDir = tempDir("first-tree-portable-s3-");
    const binDir = tempDir("first-tree-portable-aws-");
    const logPath = join(tempDir("first-tree-portable-aws-log-"), "aws.jsonl");
    const statePath = join(tempDir("first-tree-portable-aws-state-"), "state.json");
    writeReleaseFixture(outDir, "staging", "1.2.4-staging.7.1");
    writeState(statePath);
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
      fakeAwsEnv(binDir, logPath, statePath),
    );

    expect(res.status, res.stderr || res.stdout).toBe(0);
    const calls = readAwsCalls(logPath);
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.slice(0, 6)).toEqual([
        "--region",
        "auto",
        "--endpoint-url",
        "https://s3.example.com",
        "--profile",
        "portable-test",
      ]);
      expect(serviceArgs(call).slice(0, 2)).toEqual(["s3", "cp"]);
      expect(call).toContain("--dryrun");
    }
  });
});
