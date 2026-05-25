import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Post-bundle channel-home isolation: spawns the **built dist binary**
 * (not source) with a controlled `HOME` env and asserts the resolved
 * `defaultHome()` equals `channelConfig.defaultHome`.
 *
 * Why this test is load-bearing: the previous design relied on the
 * channel-env side-effect setting `process.env.FIRST_TREE_HOME` BEFORE
 * the resolver const evaluated. Source-mode tests passed (lazy load
 * order works in `tsx`), but after tsdown bundled the workspace, ESM
 * hoisted every chunk's top-level evaluation BEFORE the importing
 * module's body — so the resolver const locked to the prod fallback
 * `~/.first-tree`, silently making staging / dev daemons embed
 * `FIRST_TREE_HOME=~/.first-tree` in their service unit files. Three
 * homes collapsed to one. Source-mode tests CAN NOT catch this — only
 * spawning the actual dist binary can.
 *
 * Fix: resolver paths are now functions (lazy env read at call time).
 * This test pins the contract so a future refactor that re-introduces a
 * top-level const (in resolver.ts OR any downstream module that derives
 * a const from `defaultHome()` / `defaultConfigDir()` / `defaultDataDir()`)
 * gets caught.
 *
 * Test infra: builds dist on demand via `pnpm --filter first-tree-dev
 * build` if it's missing. CI typically runs `pnpm build` before tests
 * so the build is a cached no-op.
 */
const DIST = resolve(__dirname, "../../dist/cli/index.mjs");

function ensureDistBuilt(): void {
  if (existsSync(DIST)) return;
  // Use turbo (not plain pnpm -F) so workspace dependencies
  // (`@first-tree/shared` especially) build first per turbo.json's
  // `dependsOn: ["^build"]`. A plain `pnpm --filter first-tree-dev
  // build` skips dependency resolution and fails with missing exports
  // from stale `packages/shared/dist/`.
  const build = spawnSync("pnpm", ["exec", "turbo", "run", "build", "--filter=first-tree-dev"], {
    encoding: "utf-8",
    timeout: 120_000,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    throw new Error(`turbo build failed (status ${build.status ?? "unknown"})`);
  }
  if (!existsSync(DIST)) {
    throw new Error(`build succeeded but ${DIST} still missing`);
  }
}

type HomeInfo = {
  channel: "dev" | "staging" | "prod";
  binName: string;
  packageName: string | null;
  channelDefaultHome: string;
  home: string;
  configDir: string;
  dataDir: string;
  serviceUnitFile: string;
  launchdLabel: string;
  firstTreeHomeEnv: string | null;
};

function spawnHomeInfo(env: NodeJS.ProcessEnv): HomeInfo {
  const res = spawnSync(process.execPath, [DIST, "daemon", "home-info"], {
    encoding: "utf-8",
    timeout: 10_000,
    // Use the merged env exactly — caller controls HOME / FIRST_TREE_HOME
    // / NODE_PATH explicitly.
    env,
  });
  if (res.status !== 0) {
    throw new Error(
      `daemon home-info exited with status ${res.status ?? "unknown"} (signal=${res.signal ?? "none"}). ` +
        `stdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
  }
  // home-info prints exactly one line of JSON; tolerate optional
  // trailing newline.
  const line = res.stdout.trim();
  if (!line) throw new Error(`daemon home-info produced no stdout. stderr: ${res.stderr}`);
  return JSON.parse(line) as HomeInfo;
}

describe("post-bundle channel-home isolation", () => {
  let tmpHome: string;

  beforeEach(() => {
    ensureDistBuilt();
    tmpHome = mkdtempSync(join(tmpdir(), "post-bundle-home-"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("dist binary resolves home to channel default (~/.first-tree-dev for dev channel)", () => {
    // Source tree CHANNEL = "dev" — bundled binary inherits that until CI
    // rewrites build-info.ts for prod / staging publishes. So this test
    // asserts dev channel behaviour: a fresh-env spawn must land in
    // `~/.first-tree-dev`, NOT the prod fallback `~/.first-tree`.
    const env = { ...process.env, HOME: tmpHome } as NodeJS.ProcessEnv;
    // Strip any inherited FIRST_TREE_HOME so the channel default is what
    // gets exercised — not whatever the test runner's parent shell had.
    delete env.FIRST_TREE_HOME;

    const info = spawnHomeInfo(env);

    expect(info.channel).toBe("dev");
    expect(info.binName).toBe("first-tree-dev");
    expect(info.packageName).toBeNull();
    expect(info.channelDefaultHome).toBe(join(tmpHome, ".first-tree-dev"));
    // Critical assertion: defaultHome() returned the SAME path as
    // channelConfig.defaultHome. If a future refactor re-introduces a
    // top-level const in resolver.ts (or any downstream module), this
    // assertion catches it — `home` would lock to `~/.first-tree`
    // (prod fallback) while `channelDefaultHome` stays correct, and the
    // two diverge.
    expect(info.home).toBe(info.channelDefaultHome);
    expect(info.configDir).toBe(join(info.channelDefaultHome, "config"));
    expect(info.dataDir).toBe(join(info.channelDefaultHome, "data"));
    // channel-env.ts wrote FIRST_TREE_HOME from channelConfig.defaultHome
    // — surfaced for diagnostics if this test ever fails.
    expect(info.firstTreeHomeEnv).toBe(info.channelDefaultHome);
  });

  it("respects an explicit FIRST_TREE_HOME override (highest priority)", () => {
    // The channel-env side-effect uses a falsy check, so an externally
    // set FIRST_TREE_HOME wins. This is the escape hatch operators rely
    // on for one-off test sandboxes.
    const overrideHome = join(tmpHome, "custom-home-xyz");
    const env = { ...process.env, HOME: tmpHome, FIRST_TREE_HOME: overrideHome } as NodeJS.ProcessEnv;

    const info = spawnHomeInfo(env);

    expect(info.firstTreeHomeEnv).toBe(overrideHome);
    expect(info.home).toBe(overrideHome);
    expect(info.configDir).toBe(join(overrideHome, "config"));
    expect(info.dataDir).toBe(join(overrideHome, "data"));
    // channelConfig.defaultHome is unaffected by env — it's the binary's
    // identity, not a user setting. Stays at ~/.first-tree-dev.
    expect(info.channelDefaultHome).toBe(join(tmpHome, ".first-tree-dev"));
  });

  it("service unit / launchd label come from the channel, not the home path", () => {
    // FIRST_TREE_HOME override does NOT rename the service unit — that
    // would let an operator's one-off test sandbox accidentally collide
    // with the channel's real systemd unit. Service identity is bound
    // to the channel.
    const env = {
      ...process.env,
      HOME: tmpHome,
      FIRST_TREE_HOME: join(tmpHome, "weird-path"),
    } as NodeJS.ProcessEnv;

    const info = spawnHomeInfo(env);

    expect(info.serviceUnitFile).toBe("first-tree-dev.service");
    expect(info.launchdLabel).toBe("first-tree-dev");
  });
});
