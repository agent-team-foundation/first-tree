import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { SdkError } from "@first-tree/client";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memberMocks = vi.hoisted(() => ({ createMemberSdk: vi.fn() }));
const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode: number, metadata?: { status?: string }) => {
    throw Object.assign(new Error(message), { code, exitCode, metadata });
  }),
  isJsonMode: vi.fn(() => false),
  result: vi.fn(),
  status: vi.fn(),
}));

vi.mock("../commands/_shared/member.js", () => memberMocks);
vi.mock("../core/output.js", () => ({
  isJsonMode: outputMocks.isJsonMode,
  print: {
    fail: outputMocks.fail,
    result: outputMocks.result,
    status: outputMocks.status,
  },
}));

const cleanupRoots: string[] = [];
const gitEnvKeys = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
const originalGitEnv = new Map(gitEnvKeys.map((key) => [key, process.env[key]]));

beforeEach(() => {
  vi.clearAllMocks();
  outputMocks.isJsonMode.mockReturnValue(false);
});

afterEach(() => {
  for (const key of gitEnvKeys) {
    const original = originalGitEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  for (const root of cleanupRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function commandWith(options: { snapshot?: string; team?: string }): Command {
  return { opts: () => options } as unknown as Command;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function createRemote(): { bindingRepo: string; commit: string; origin: string } {
  const root = mkdtempSync(join(tmpdir(), "ft-tree-read-command-"));
  cleanupRoots.push(root);
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const bindingRepo = "https://trees.example/command-test.git";
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "ignore" });
  execFileSync("git", ["clone", origin, seed], { stdio: "ignore" });
  git(seed, "config", "user.email", "agent@example.com");
  git(seed, "config", "user.name", "Agent");
  writeFileSync(join(seed, "NODE.md"), '---\ntitle: "Tree"\nowners: [owner]\n---\n');
  git(seed, "add", ".");
  git(seed, "commit", "-m", "seed tree");
  git(seed, "push", "origin", "main");
  return { bindingRepo, commit: git(seed, "rev-parse", "HEAD"), origin };
}

describe("tree read command action", () => {
  it("rejects missing explicit Team input before constructing the member SDK", async () => {
    const { runTreeReadCommand } = await import("../commands/tree/read.js");

    await expect(
      runTreeReadCommand({
        command: commandWith({ snapshot: "/tmp/unused-context-tree" }),
        options: { debug: false, json: true, quiet: false },
      }),
    ).rejects.toMatchObject({
      code: "CONTEXT_TREE_READ_INVALID_INPUT",
      exitCode: 2,
      metadata: { status: "input" },
    });
    expect(memberMocks.createMemberSdk).not.toHaveBeenCalled();
  });

  it("reports the explicit Team, safe binding, exact commit, and canonical snapshot path", async () => {
    const remote = createRemote();
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(remote.origin).href}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = remote.bindingRepo;
    const getMemberContextTreeSetting = vi.fn(async () => ({ repo: remote.bindingRepo, branch: "main" }));
    memberMocks.createMemberSdk.mockReturnValue({ getMemberContextTreeSetting });
    const snapshotPath = join(cleanupRoots[0] ?? "", "snapshot");
    const { runTreeReadCommand } = await import("../commands/tree/read.js");

    await runTreeReadCommand({
      command: commandWith({ snapshot: snapshotPath, team: "team-command" }),
      options: { debug: false, json: true, quiet: false },
    });

    expect(memberMocks.createMemberSdk).toHaveBeenCalledTimes(1);
    expect(getMemberContextTreeSetting).toHaveBeenCalledTimes(1);
    expect(getMemberContextTreeSetting).toHaveBeenCalledWith("team-command", { retry: false });
    expect(outputMocks.status).not.toHaveBeenCalled();
    expect(outputMocks.result).toHaveBeenCalledWith({
      teamId: "team-command",
      binding: { repo: remote.bindingRepo, branch: "main" },
      commit: remote.commit,
      snapshotPath: realpathSync(snapshotPath),
    });
  });

  it("keeps human output readable without appending a JSON result envelope", async () => {
    const remote = createRemote();
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(remote.origin).href}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = remote.bindingRepo;
    memberMocks.createMemberSdk.mockReturnValue({
      getMemberContextTreeSetting: vi.fn(async () => ({ repo: remote.bindingRepo, branch: "main" })),
    });
    const snapshotPath = join(cleanupRoots[0] ?? "", "human-snapshot");
    const { runTreeReadCommand } = await import("../commands/tree/read.js");

    await runTreeReadCommand({
      command: commandWith({ snapshot: snapshotPath, team: "team-command" }),
      options: { debug: false, json: false, quiet: false },
    });

    expect(outputMocks.status.mock.calls).toEqual([
      ["Team", "team-command"],
      ["Provider", "legacy/unresolved"],
      ["Binding", `${remote.bindingRepo}#main`],
      ["Exact commit", remote.commit],
      ["Snapshot", realpathSync(snapshotPath)],
    ]);
    expect(outputMocks.result).not.toHaveBeenCalled();
  });

  it("maps authority denial to a stable stage without exposing the upstream response", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-tree-read-command-denied-"));
    cleanupRoots.push(root);
    const getMemberContextTreeSetting = vi.fn(async () => {
      throw new SdkError(403, "private response with credential=do-not-leak");
    });
    memberMocks.createMemberSdk.mockReturnValue({ getMemberContextTreeSetting });
    const { runTreeReadCommand } = await import("../commands/tree/read.js");

    await expect(
      runTreeReadCommand({
        command: commandWith({ snapshot: join(root, "snapshot"), team: "team-denied" }),
        options: { debug: false, json: true, quiet: false },
      }),
    ).rejects.toMatchObject({
      code: "CONTEXT_TREE_READ_AUTHORITY_FAILED",
      exitCode: 3,
      metadata: { status: "authority" },
    });
    expect(outputMocks.fail.mock.calls[0]?.[1]).not.toContain("do-not-leak");
    expect(outputMocks.fail.mock.calls[0]?.[1]).not.toContain("credential");
    expect(getMemberContextTreeSetting).toHaveBeenCalledTimes(1);
  });
});
