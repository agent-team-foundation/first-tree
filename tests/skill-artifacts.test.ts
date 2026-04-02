import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function readPortableSnapshotCommit(quickstart: string): string {
  const match = quickstart.match(
    /snapshot base commit when this portable copy was refreshed: `([0-9a-f]{40})`/,
  );

  expect(match, "portable quickstart should record the snapshot source commit").not.toBeNull();
  return match![1];
}

function readPortableSnapshotFingerprint(quickstart: string): string {
  const match = quickstart.match(/snapshot content fingerprint: `(sha256:[0-9a-f]{64})`/);

  expect(match, "portable quickstart should record the snapshot fingerprint").not.toBeNull();
  return match![1];
}

describe("skill artifacts", () => {
  it("keeps the source-of-truth skill and generated mirrors present", () => {
    expect(existsSync(join(ROOT, "skills", "first-tree-cli-framework", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ROOT, ".agents", "skills", "first-tree-cli-framework", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ROOT, ".claude", "skills", "first-tree-cli-framework", "SKILL.md"))).toBe(true);
  });

  it("keeps the skill source, mirrors, and snapshot in sync", () => {
    execFileSync("bash", ["./skills/first-tree-cli-framework/scripts/check-skill-sync.sh"], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf-8",
    });
  });

  it("passes the portable smoke test", () => {
    execFileSync("bash", ["./skills/first-tree-cli-framework/scripts/portable-smoke-test.sh"], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf-8",
    });
  });

  it("keeps naming and installation guidance aligned", () => {
    const read = (path: string) => readFileSync(join(ROOT, path), "utf-8");

    expect(read("README.md")).not.toContain("seed-tree");
    expect(read("docs/onboarding.md")).not.toContain("seed-tree");
    expect(read("AGENTS.md")).not.toContain("seed-tree");

    const onboarding = read("docs/onboarding.md");
    expect(onboarding).toContain("npx first-tree init");
    expect(onboarding).toContain("npm install -g first-tree");

    const quickstart = read("skills/first-tree-cli-framework/references/portable-quickstart.md");
    expect(quickstart).toContain("npx first-tree --help");
    expect(quickstart).toContain("npm install -g first-tree");
    expect(quickstart).toContain("strict sync validation uses the content fingerprint above");

    const snapshotCommit = readPortableSnapshotCommit(quickstart);
    const snapshotFingerprint = readPortableSnapshotFingerprint(quickstart);
    const headCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf-8",
    }).trim();
    const computedFingerprint = execFileSync(
      "python3",
      ["./skills/first-tree-cli-framework/scripts/snapshot_fingerprint.py", "--root", ROOT],
      {
        cwd: ROOT,
        encoding: "utf-8",
      },
    ).trim();
    let commitIsAvailable = true;
    try {
      execFileSync("git", ["cat-file", "-e", `${snapshotCommit}^{commit}`], {
        cwd: ROOT,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch {
      commitIsAvailable = false;
    }

    if (commitIsAvailable) {
      const mergeBase = execFileSync("git", ["merge-base", snapshotCommit, headCommit], {
        cwd: ROOT,
        encoding: "utf-8",
      }).trim();

      expect(mergeBase).toBe(snapshotCommit);
    }

    expect(snapshotFingerprint).toBe(computedFingerprint);
  });
});
