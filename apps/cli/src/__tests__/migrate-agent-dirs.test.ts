import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateLocalAgentDirs, type NameResolver } from "../core/migrate-agent-dirs.js";

/**
 * Pins the Phase-3 local-dir rename. The helper is a pure filesystem shuffler
 * driven by an injected name resolver; we stub the resolver in-memory so the
 * tests don't need a live server.
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

function writeLegacyRuntime(root: string, name: string, opts?: { markerFile?: boolean }) {
  const workspace = writeWorkspace(root, name);
  mkdirSync(join(workspace, ".agent", "context"), { recursive: true });
  writeFileSync(join(workspace, ".agent", "identity.json"), '{"agentId":"legacy"}');
  writeFileSync(join(workspace, ".agent", "cli-version"), "0.1.0\n");
  writeFileSync(join(workspace, ".agent", "tools.md"), "legacy tools");
  writeFileSync(join(workspace, ".agent", "context", "agent-instructions.md"), "legacy");
  if (opts?.markerFile) {
    writeFileSync(join(workspace, ".first-tree-workspace"), "");
  }
  return workspace;
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

  it("migrates a legacy runtime dir even when the local agent dir name already matches", async () => {
    writeAgentYaml(root, "alice", "uuid-1");
    writeLegacyRuntime(root, "alice", { markerFile: true });

    const res = await migrateLocalAgentDirs({
      ...dirs({ root }),
      resolver: mkResolver({ "uuid-1": "alice" }),
    });

    expect(res).toEqual({ scanned: 1, renamed: 0, skipped: 0, errors: 0 });
    expect(existsSync(join(dirs({ root }).workspacesDir, "alice", ".agent"))).toBe(false);
    expect(statSync(join(dirs({ root }).workspacesDir, "alice", ".first-tree-workspace")).isDirectory()).toBe(true);
    expect(
      readFileSync(join(dirs({ root }).workspacesDir, "alice", ".first-tree-workspace", "identity.json"), "utf-8"),
    ).toBe('{"agentId":"legacy"}');
    expect(existsSync(join(dirs({ root }).workspacesDir, "alice", ".first-tree-workspace", "tools.md"))).toBe(false);
    expect(existsSync(join(dirs({ root }).workspacesDir, "alice", ".first-tree-workspace", "context"))).toBe(false);
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

  it("migrates the legacy runtime layout during a workspace rename", async () => {
    writeAgentYaml(root, "old-alias", "uuid-1");
    writeLegacyRuntime(root, "old-alias", { markerFile: true });

    const res = await migrateLocalAgentDirs({
      ...dirs({ root }),
      resolver: mkResolver({ "uuid-1": "alice" }),
    });

    expect(res.renamed).toBe(1);
    expect(existsSync(join(dirs({ root }).workspacesDir, "old-alias"))).toBe(false);
    expect(statSync(join(dirs({ root }).workspacesDir, "alice", ".first-tree-workspace")).isDirectory()).toBe(true);
    expect(existsSync(join(dirs({ root }).workspacesDir, "alice", ".agent"))).toBe(false);
    expect(existsSync(join(dirs({ root }).workspacesDir, "alice", ".first-tree-workspace", "context"))).toBe(false);
    expect(existsSync(join(dirs({ root }).workspacesDir, "alice", ".first-tree-workspace", "tools.md"))).toBe(false);
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

  it("renames the config dir even when workspaces and sessions dirs don't exist (fresh client)", async () => {
    writeAgentYaml(root, "old-alias", "uuid-1");
    // Deliberately skip writeWorkspace / writeSessionFile.
    const res = await migrateLocalAgentDirs({
      ...dirs({ root }),
      resolver: mkResolver({ "uuid-1": "alice" }),
    });
    expect(res.renamed).toBe(1);
    expect(res.errors).toBe(0);
    expect(readdirSync(dirs({ root }).agentsDir)).toEqual(["alice"]);
  });

  it("leaves old workspace in place and logs when the new workspace target already exists (partial failure)", async () => {
    writeAgentYaml(root, "old-alias", "uuid-1");
    writeLegacyRuntime(root, "old-alias");
    writeLegacyRuntime(root, "alice"); // pre-existing target — rename would clobber
    writeSessionFile(root, "old-alias");
    const res = await migrateLocalAgentDirs({
      ...dirs({ root }),
      resolver: mkResolver({ "uuid-1": "alice" }),
    });
    // Config dir renamed; workspace left alone; sessions file renamed.
    expect(res.renamed).toBe(1);
    expect(readdirSync(dirs({ root }).agentsDir)).toEqual(["alice"]);
    // Both workspaces should still exist.
    const wsNames = readdirSync(dirs({ root }).workspacesDir).sort();
    expect(wsNames).toEqual(["alice", "old-alias"]);
    expect(statSync(join(dirs({ root }).workspacesDir, "alice", ".first-tree-workspace")).isDirectory()).toBe(true);
    expect(existsSync(join(dirs({ root }).workspacesDir, "alice", ".agent"))).toBe(false);
    expect(existsSync(join(dirs({ root }).workspacesDir, "alice", ".first-tree-workspace", "context"))).toBe(false);
    expect(existsSync(join(dirs({ root }).workspacesDir, "alice", ".first-tree-workspace", "tools.md"))).toBe(false);
  });

  it("skips and logs when agent.yaml is malformed (does not abort migration for healthy siblings)", async () => {
    writeAgentYaml(root, "alice", "uuid-1");
    // Write an "agent" dir with a broken yaml.
    const brokenDir = join(root, "config", "agents", "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "agent.yaml"), "this: is: : not yaml\n");
    writeAgentYaml(root, "bob", "uuid-2");
    const res = await migrateLocalAgentDirs({
      ...dirs({ root }),
      resolver: mkResolver({ "uuid-1": "alice", "uuid-2": "bob" }),
    });
    // alice + bob scanned (2), broken dir errored but didn't stop the walk.
    expect(res.scanned).toBe(2);
    expect(res.errors).toBe(1);
    // All three dirs still present — broken one left for operator to fix.
    expect(readdirSync(dirs({ root }).agentsDir).sort()).toEqual(["alice", "bob", "broken"]);
  });
});
