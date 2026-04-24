import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateLocalAgentDirs, type NameResolver } from "../core/migrate-agent-dirs.js";

/**
 * Pins the Phase-3 local-dir rename. The helper is a pure filesystem shuffler
 * driven by an injected name resolver; we stub the resolver in-memory so the
 * tests don't need a live Hub.
 *
 * What we specifically want to guard against:
 *   1. Renaming is idempotent (already-aligned dirs are untouched).
 *   2. A collision (target name already exists) skips + logs — no clobber.
 *   3. A resolver that knows nothing about an agentId leaves the dir alone.
 *   4. A resolver failure aborts the walk so we don't spam warnings.
 */

function writeAgentYaml(root: string, name: string, agentId: string) {
  const dir = join(root, "config", "agents", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.yaml"), `agentId: ${agentId}\nruntime: claude-code\n`);
  return dir;
}

function writeWorkspace(root: string, name: string) {
  const dir = join(root, "data", "workspaces", name);
  mkdirSync(join(dir, "chat-1"), { recursive: true });
  writeFileSync(join(dir, "chat-1", "noop"), "");
  return dir;
}

function writeSessionFile(root: string, name: string) {
  const dir = join(root, "data", "sessions");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${name}.json`);
  writeFileSync(p, "{}\n");
  return p;
}

function mkResolver(map: Record<string, string | null>): NameResolver {
  return {
    async resolveName(agentId) {
      return Object.hasOwn(map, agentId) ? (map[agentId] ?? null) : null;
    },
  };
}

function dirs(opts: { root: string }) {
  return {
    agentsDir: join(opts.root, "config", "agents"),
    workspacesDir: join(opts.root, "data", "workspaces"),
    sessionsDir: join(opts.root, "data", "sessions"),
  };
}

describe("migrateLocalAgentDirs", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fthub-migrate-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns scanned=0 when the agents dir doesn't exist (first-run clients)", async () => {
    const res = await migrateLocalAgentDirs({ ...dirs({ root }), resolver: mkResolver({}) });
    expect(res).toEqual({ scanned: 0, renamed: 0, skipped: 0, errors: 0 });
  });

  it("is a no-op when every local dir already matches the server name", async () => {
    writeAgentYaml(root, "alice", "uuid-1");
    writeAgentYaml(root, "bob", "uuid-2");
    const res = await migrateLocalAgentDirs({
      ...dirs({ root }),
      resolver: mkResolver({ "uuid-1": "alice", "uuid-2": "bob" }),
    });
    expect(res).toEqual({ scanned: 2, renamed: 0, skipped: 0, errors: 0 });
    // Dirs still there under the original names.
    expect(readdirSync(dirs({ root }).agentsDir).sort()).toEqual(["alice", "bob"]);
  });

  it("renames config dir, workspace, and sessions file when the server name differs", async () => {
    writeAgentYaml(root, "old-alias", "uuid-1");
    writeWorkspace(root, "old-alias");
    writeSessionFile(root, "old-alias");
    const res = await migrateLocalAgentDirs({
      ...dirs({ root }),
      resolver: mkResolver({ "uuid-1": "alice" }),
    });
    expect(res.renamed).toBe(1);
    expect(res.errors).toBe(0);
    expect(readdirSync(dirs({ root }).agentsDir)).toEqual(["alice"]);
    expect(statSync(join(dirs({ root }).workspacesDir, "alice")).isDirectory()).toBe(true);
    expect(statSync(join(dirs({ root }).sessionsDir, "alice.json")).isFile()).toBe(true);
  });

  it("skips without clobbering when the target config dir already exists", async () => {
    writeAgentYaml(root, "old-alias", "uuid-1");
    writeAgentYaml(root, "alice", "uuid-2");
    const res = await migrateLocalAgentDirs({
      ...dirs({ root }),
      resolver: mkResolver({ "uuid-1": "alice", "uuid-2": "alice" }),
    });
    // One rename would attempt old-alias → alice but alice is already taken.
    expect(res.skipped).toBeGreaterThan(0);
    expect(readdirSync(dirs({ root }).agentsDir).sort()).toEqual(["alice", "old-alias"]);
  });

  it("leaves a dir alone when the resolver has no answer for its agentId (tombstone / unlisted)", async () => {
    writeAgentYaml(root, "mystery", "uuid-unknown");
    const res = await migrateLocalAgentDirs({
      ...dirs({ root }),
      resolver: mkResolver({}),
    });
    expect(res.scanned).toBe(1);
    expect(res.renamed).toBe(0);
    expect(res.skipped).toBe(1);
    expect(readdirSync(dirs({ root }).agentsDir)).toEqual(["mystery"]);
  });

  it("aborts the walk on a resolver failure (one warning, not N)", async () => {
    writeAgentYaml(root, "a", "uuid-1");
    writeAgentYaml(root, "b", "uuid-2");
    writeAgentYaml(root, "c", "uuid-3");
    const failing: NameResolver = {
      async resolveName() {
        throw new Error("network down");
      },
    };
    const res = await migrateLocalAgentDirs({ ...dirs({ root }), resolver: failing });
    expect(res.errors).toBe(1);
    expect(res.renamed).toBe(0);
    // All dirs intact.
    expect(readdirSync(dirs({ root }).agentsDir).sort()).toEqual(["a", "b", "c"]);
  });

  it("is idempotent when re-run after a successful rename", async () => {
    writeAgentYaml(root, "old-alias", "uuid-1");
    const resolver = mkResolver({ "uuid-1": "alice" });
    const first = await migrateLocalAgentDirs({ ...dirs({ root }), resolver });
    expect(first.renamed).toBe(1);
    const second = await migrateLocalAgentDirs({ ...dirs({ root }), resolver });
    expect(second.renamed).toBe(0);
    expect(readdirSync(dirs({ root }).agentsDir)).toEqual(["alice"]);
  });
});
