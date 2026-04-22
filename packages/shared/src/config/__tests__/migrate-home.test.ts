import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyHome } from "../migrate-home.js";

let sandbox: string;
let legacy: string;
let newHome: string;

beforeEach(() => {
  sandbox = join(tmpdir(), `ftt-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(sandbox, { recursive: true });
  legacy = join(sandbox, "legacy", ".first-tree-hub");
  newHome = join(sandbox, "new", ".first-tree", "hub");
});

afterEach(() => {
  if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
});

function seedLegacy(): void {
  mkdirSync(join(legacy, "config"), { recursive: true });
  mkdirSync(join(legacy, "data", "workspaces"), { recursive: true });
  writeFileSync(join(legacy, "config", "credentials.json"), '{"accessToken":"abc"}');
  writeFileSync(join(legacy, "data", "workspaces", "marker"), "hello");
}

describe("migrateLegacyHome", () => {
  it("skips when the legacy dir does not exist", () => {
    const res = migrateLegacyHome({ newHome, legacyHome: legacy, envOverride: null });
    expect(res.migrated).toBe(false);
    if (!res.migrated) expect(res.reason).toBe("no-legacy-dir");
    expect(existsSync(newHome)).toBe(false);
  });

  it("skips when FIRST_TREE_HUB_HOME is set (user-controlled home)", () => {
    seedLegacy();
    const res = migrateLegacyHome({
      newHome,
      legacyHome: legacy,
      envOverride: "/some/custom/path",
    });
    expect(res.migrated).toBe(false);
    if (!res.migrated) expect(res.reason).toBe("custom-home");
    // Legacy dir must be untouched so the custom-home user can inspect it.
    expect(existsSync(legacy)).toBe(true);
  });

  it("copies the entire legacy home tree into the new location AND preserves the legacy as a backup", () => {
    seedLegacy();
    const res = migrateLegacyHome({ newHome, legacyHome: legacy, envOverride: null });
    expect(res.migrated).toBe(true);
    if (res.migrated) {
      expect(res.from).toBe(legacy);
      expect(res.to).toBe(newHome);
    }
    // Copy semantics: BOTH locations exist after migration. Legacy is the
    // safety-net backup the user can delete manually once verified.
    expect(existsSync(legacy)).toBe(true);
    expect(readFileSync(join(legacy, "config", "credentials.json"), "utf-8")).toBe('{"accessToken":"abc"}');
    expect(readFileSync(join(newHome, "config", "credentials.json"), "utf-8")).toBe('{"accessToken":"abc"}');
    expect(readFileSync(join(newHome, "data", "workspaces", "marker"), "utf-8")).toBe("hello");
  });

  it("creates the parent `.first-tree/` dir when missing", () => {
    seedLegacy();
    // Parent does not exist yet.
    expect(existsSync(join(sandbox, "new", ".first-tree"))).toBe(false);

    const res = migrateLegacyHome({ newHome, legacyHome: legacy, envOverride: null });
    expect(res.migrated).toBe(true);
    expect(existsSync(join(sandbox, "new", ".first-tree"))).toBe(true);
  });

  it("copies into an existing empty new dir (e.g. sibling product already created `.first-tree/`)", () => {
    seedLegacy();
    mkdirSync(newHome, { recursive: true });
    // New dir exists but empty — should still migrate.

    const res = migrateLegacyHome({ newHome, legacyHome: legacy, envOverride: null });
    expect(res.migrated).toBe(true);
    expect(existsSync(join(newHome, "config", "credentials.json"))).toBe(true);
    // Legacy preserved.
    expect(existsSync(join(legacy, "config", "credentials.json"))).toBe(true);
  });

  it("refuses to overwrite when the new dir already has content", () => {
    seedLegacy();
    mkdirSync(newHome, { recursive: true });
    writeFileSync(join(newHome, "pre-existing.txt"), "already here");

    const res = migrateLegacyHome({ newHome, legacyHome: legacy, envOverride: null });
    expect(res.migrated).toBe(false);
    if (!res.migrated) expect(res.reason).toBe("new-dir-populated");
    // Both dirs untouched so the user can inspect/resolve manually.
    expect(existsSync(join(legacy, "config", "credentials.json"))).toBe(true);
    expect(readFileSync(join(newHome, "pre-existing.txt"), "utf-8")).toBe("already here");
  });

  it("is idempotent — second call after a successful migration is a no-op (target populated)", () => {
    seedLegacy();
    const first = migrateLegacyHome({ newHome, legacyHome: legacy, envOverride: null });
    expect(first.migrated).toBe(true);

    // Legacy still exists after copy, so the "new-dir-populated" rule is
    // what keeps us from re-copying and potentially clobbering live edits
    // that happened against the new location between runs.
    const second = migrateLegacyHome({ newHome, legacyHome: legacy, envOverride: null });
    expect(second.migrated).toBe(false);
    if (!second.migrated) expect(second.reason).toBe("new-dir-populated");
  });

  it("copies even an empty legacy dir (the user was on the old layout)", () => {
    // An empty legacy dir still means the user had the pre-v0.9 layout;
    // we create the target parent so subsequent writes land in the new path.
    mkdirSync(legacy, { recursive: true });
    const res = migrateLegacyHome({ newHome, legacyHome: legacy, envOverride: null });
    expect(res.migrated).toBe(true);
    // Legacy preserved.
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(newHome)).toBe(true);
  });

  it("preserves directory modes (Node's cpSync regression — credentials/ must stay 0700)", () => {
    // Seed a 0700 config dir with a 0600 secret inside. This mirrors the
    // on-disk shape that `ensureDir(..., 0o700)` produces in resolver.ts.
    mkdirSync(join(legacy, "config"), { recursive: true });
    mkdirSync(join(legacy, "config", "agents"), { recursive: true });
    writeFileSync(join(legacy, "config", "credentials.json"), '{"t":"x"}', { mode: 0o600 });
    chmodSync(join(legacy, "config"), 0o700);
    chmodSync(join(legacy, "config", "agents"), 0o700);
    // Leave a 0755 sibling so we know the fix isn't just blanket-setting 0700.
    mkdirSync(join(legacy, "data", "sessions"), { recursive: true });
    chmodSync(join(legacy, "data"), 0o755);

    const res = migrateLegacyHome({ newHome, legacyHome: legacy, envOverride: null });
    expect(res.migrated).toBe(true);

    expect(statSync(join(newHome, "config")).mode & 0o7777).toBe(0o700);
    expect(statSync(join(newHome, "config", "agents")).mode & 0o7777).toBe(0o700);
    expect(statSync(join(newHome, "data")).mode & 0o7777).toBe(0o755);
    // File modes were already handled by cpSync but re-assert to lock it in.
    expect(statSync(join(newHome, "config", "credentials.json")).mode & 0o7777).toBe(0o600);
  });

  it("preserves file contents byte-for-byte (not a silent rewrite)", () => {
    mkdirSync(legacy, { recursive: true });
    const payload = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x10, 0x20]);
    writeFileSync(join(legacy, "binary.dat"), payload);

    const res = migrateLegacyHome({ newHome, legacyHome: legacy, envOverride: null });
    expect(res.migrated).toBe(true);
    const copied = readFileSync(join(newHome, "binary.dat"));
    expect(copied.equals(payload)).toBe(true);
  });
});
