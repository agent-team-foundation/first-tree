import { describe, expect, it } from "vitest";
import {
  DIFF_NOISE_PATTERNS,
  filterDiffNoise,
  isDiffNoise,
} from "#products/gardener/engine/classifiers/diff-filter.js";

describe("isDiffNoise", () => {
  it("flags lockfiles at root and in subdirs", () => {
    expect(isDiffNoise("pnpm-lock.yaml")).toBe(true);
    expect(isDiffNoise("apps/web/package-lock.json")).toBe(true);
    expect(isDiffNoise("rust/Cargo.lock")).toBe(true);
    expect(isDiffNoise("py/poetry.lock")).toBe(true);
  });

  it("flags build output dirs", () => {
    expect(isDiffNoise("dist/index.js")).toBe(true);
    expect(isDiffNoise("build/output.js")).toBe(true);
    expect(isDiffNoise("coverage/lcov.info")).toBe(true);
    expect(isDiffNoise("node_modules/foo/index.js")).toBe(true);
    expect(isDiffNoise("__pycache__/mod.cpython-311.pyc")).toBe(true);
  });

  it("flags minified and map artifacts", () => {
    expect(isDiffNoise("vendor/jquery.min.js")).toBe(true);
    expect(isDiffNoise("styles.min.css")).toBe(true);
    expect(isDiffNoise("bundle.js.map")).toBe(true);
    expect(isDiffNoise("snapshots/foo.snap")).toBe(true);
  });

  it("does not flag real source files", () => {
    expect(isDiffNoise("src/index.ts")).toBe(false);
    expect(isDiffNoise("README.md")).toBe(false);
    expect(isDiffNoise("apps/web/src/App.tsx")).toBe(false);
    // A file literally named "lock.ts" should NOT match — the .lock
    // pattern requires the extension, not a substring.
    expect(isDiffNoise("lock.ts")).toBe(false);
  });

  it("exports a non-empty pattern list", () => {
    expect(DIFF_NOISE_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe("filterDiffNoise", () => {
  it("returns empty diff untouched", () => {
    expect(filterDiffNoise("")).toBe("");
  });

  it("drops a lockfile hunk while keeping real-code hunks", () => {
    const diff = [
      "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
      "index 111..222 100644",
      "--- a/pnpm-lock.yaml",
      "+++ b/pnpm-lock.yaml",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "diff --git a/src/index.ts b/src/index.ts",
      "index 333..444 100644",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -1,1 +1,1 @@",
      "-export const x = 1;",
      "+export const x = 2;",
      "",
    ].join("\n");
    const out = filterDiffNoise(diff);
    expect(out).not.toContain("pnpm-lock.yaml");
    expect(out).toContain("src/index.ts");
    expect(out).toContain("export const x = 2;");
  });

  it("drops dist/ hunks", () => {
    const diff = [
      "diff --git a/dist/bundle.js b/dist/bundle.js",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/src/app.ts b/src/app.ts",
      "@@ -1 +1 @@",
      "-c",
      "+d",
      "",
    ].join("\n");
    const out = filterDiffNoise(diff);
    expect(out).not.toContain("dist/bundle.js");
    expect(out).toContain("src/app.ts");
  });

  it("keeps entire diff when nothing is noise", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/src/b.ts b/src/b.ts",
      "@@ -1 +1 @@",
      "-m",
      "+n",
      "",
    ].join("\n");
    const out = filterDiffNoise(diff);
    expect(out).toBe(diff);
  });

  it("returns empty when every hunk is noise", () => {
    const diff = [
      "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/dist/out.js b/dist/out.js",
      "@@ -1 +1 @@",
      "-c",
      "+d",
      "",
    ].join("\n");
    const out = filterDiffNoise(diff);
    expect(out.trim()).toBe("");
  });

  it("preserves hunks with unparseable headers (fail-open)", () => {
    const diff = [
      "diff --git malformed-header-no-paths",
      "some body",
      "diff --git a/src/ok.ts b/src/ok.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");
    const out = filterDiffNoise(diff);
    // malformed hunk should NOT be silently dropped
    expect(out).toContain("malformed-header-no-paths");
    expect(out).toContain("src/ok.ts");
  });
});
