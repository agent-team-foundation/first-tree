import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../");

function readPortableSnapshotCommit(quickstart: string): string {
  const match = quickstart.match(/snapshot base commit when this portable copy was refreshed: `([0-9a-f]{40})`/);

  expect(match, "portable quickstart should record the snapshot source commit").not.toBeNull();
  if (!match) {
    throw new Error("portable quickstart should record the snapshot source commit");
  }
  const [, commit] = match;
  if (!commit) {
    throw new Error("portable quickstart should record the snapshot source commit");
  }
  return commit;
}

function readPortableSnapshotFingerprint(quickstart: string): string {
  const match = quickstart.match(/snapshot content fingerprint: `(sha256:[0-9a-f]{64})`/);

  expect(match, "portable quickstart should record the snapshot fingerprint").not.toBeNull();
  if (!match) {
    throw new Error("portable quickstart should record the snapshot fingerprint");
  }
  const [, fingerprint] = match;
  if (!fingerprint) {
    throw new Error("portable quickstart should record the snapshot fingerprint");
  }
  return fingerprint;
}

describe("skill artifacts", () => {
  it("keeps the source-of-truth skill and generated mirrors present", () => {
    expect(existsSync(join(ROOT, "skills", "first-tree-hub-cli", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ROOT, ".agents", "skills", "first-tree-hub-cli", "SKILL.md"))).toBe(true);
    expect(existsSync(join(ROOT, ".claude", "skills", "first-tree-hub-cli", "SKILL.md"))).toBe(true);
  });

  it("keeps the skill source and mirrors in sync", () => {
    execFileSync("bash", ["./skills/first-tree-hub-cli/scripts/check-skill-sync.sh"], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf-8",
    });
  });

  it("passes the portable smoke test", () => {
    execFileSync("bash", ["./skills/first-tree-hub-cli/scripts/portable-smoke-test.sh"], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf-8",
    });
  });

  it("keeps portable guidance and snapshot metadata aligned", () => {
    const read = (path: string) => readFileSync(join(ROOT, path), "utf-8");

    const quickstart = read("skills/first-tree-hub-cli/references/portable-quickstart.md");
    expect(quickstart).toContain("@agent-team-foundation/first-tree-hub");
    expect(quickstart).toContain("strict sync validation uses the content fingerprint above");

    const snapshotCommit = readPortableSnapshotCommit(quickstart);
    const snapshotFingerprint = readPortableSnapshotFingerprint(quickstart);
    const headCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf-8",
    }).trim();
    const computedFingerprint = execFileSync(
      "python3",
      ["./skills/first-tree-hub-cli/scripts/snapshot_fingerprint.py", "--root", ROOT],
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
