import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findStaleAliases, formatStaleReason, type PinnedAgent, removeLocalAgent } from "../core/agent-prune.js";

/**
 * Pins the four cases that drove the rewrite:
 *   1. all aliases pinned to me → empty result
 *   2. agentId present in server response but on another client → "pinned-elsewhere"
 *   3. agentId not in server response at all → "unowned"
 *   4. broken / missing yaml → "unreadable" (must not throw — this is the
 *      junk-dir case that broke the previous loadAgents-based impl)
 *
 * The SDK call is injected as `listPinnedAgents`, so these tests don't
 * need to spin up a server or stub fetch.
 */

const THIS_CLIENT = "client_self";
const OTHER_CLIENT = "client_other";

function writeAlias(agentsDir: string, name: string, body: string): void {
  const dir = join(agentsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.yaml"), body);
}

let agentsDir: string;
const originalHome = process.env.FIRST_TREE_HOME;

beforeEach(() => {
  agentsDir = mkdtempSync(join(tmpdir(), "fthub-prune-"));
});

afterEach(() => {
  rmSync(agentsDir, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalHome;
});

describe("findStaleAliases", () => {
  it("returns empty when every local alias maps to a pinned agent on this client", async () => {
    writeAlias(agentsDir, "alpha", "agentId: 00000000-0000-0000-0000-00000000aaaa\nruntime: claude-code\n");
    writeAlias(agentsDir, "beta", "agentId: 00000000-0000-0000-0000-00000000bbbb\nruntime: claude-code\n");

    const remote: PinnedAgent[] = [
      { agentId: "00000000-0000-0000-0000-00000000aaaa", clientId: THIS_CLIENT },
      { agentId: "00000000-0000-0000-0000-00000000bbbb", clientId: THIS_CLIENT },
    ];

    const stale = await findStaleAliases({
      agentsDir,
      clientId: THIS_CLIENT,
      listPinnedAgents: async () => remote,
    });
    expect(stale).toEqual([]);
  });

  it("keeps suspended aliases pinned to this client out of the prune set", async () => {
    writeAlias(agentsDir, "paused", "agentId: 00000000-0000-0000-0000-00000000ssss\nruntime: claude-code\n");

    const remote: PinnedAgent[] = [
      { agentId: "00000000-0000-0000-0000-00000000ssss", clientId: THIS_CLIENT, status: "suspended" },
    ];

    const stale = await findStaleAliases({
      agentsDir,
      clientId: THIS_CLIENT,
      listPinnedAgents: async () => remote,
    });
    expect(stale).toEqual([]);
  });

  it("classifies an agentId pinned to a different client as pinned-elsewhere", async () => {
    writeAlias(agentsDir, "shared-name", "agentId: 00000000-0000-0000-0000-00000000cccc\nruntime: claude-code\n");

    const remote: PinnedAgent[] = [{ agentId: "00000000-0000-0000-0000-00000000cccc", clientId: OTHER_CLIENT }];

    const stale = await findStaleAliases({
      agentsDir,
      clientId: THIS_CLIENT,
      listPinnedAgents: async () => remote,
    });
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({
      name: "shared-name",
      agentId: "00000000-0000-0000-0000-00000000cccc",
      reason: { kind: "pinned-elsewhere", clientId: OTHER_CLIENT },
    });
  });

  it("classifies an unknown agentId as unowned", async () => {
    writeAlias(agentsDir, "ghost", "agentId: 00000000-0000-0000-0000-00000000dead\nruntime: claude-code\n");

    const stale = await findStaleAliases({
      agentsDir,
      clientId: THIS_CLIENT,
      listPinnedAgents: async () => [],
    });
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({
      name: "ghost",
      agentId: "00000000-0000-0000-0000-00000000dead",
      reason: { kind: "unowned" },
    });
  });

  it("classifies a malformed yaml as unreadable (does not throw)", async () => {
    // Real-world junk: dir exists, yaml is empty / has no agentId — used to
    // crash the entire prune via Zod throwing inside loadAgents.
    writeAlias(agentsDir, "d", "this: is: not: valid: yaml: at: all\n  - broken");
    writeAlias(agentsDir, "no-id", "runtime: claude-code\n");
    // And a dir with no yaml at all.
    mkdirSync(join(agentsDir, "empty-dir"), { recursive: true });

    const stale = await findStaleAliases({
      agentsDir,
      clientId: THIS_CLIENT,
      listPinnedAgents: async () => [],
    });
    expect(stale).toHaveLength(3);
    for (const s of stale) {
      expect(s.agentId).toBeNull();
      expect(s.reason.kind).toBe("unreadable");
    }
    expect(stale.map((s) => s.name).sort()).toEqual(["d", "empty-dir", "no-id"]);
  });

  it("returns mixed results when good and bad aliases coexist", async () => {
    writeAlias(agentsDir, "active", "agentId: 00000000-0000-0000-0000-00000000aaaa\nruntime: claude-code\n");
    writeAlias(agentsDir, "moved", "agentId: 00000000-0000-0000-0000-00000000bbbb\nruntime: claude-code\n");
    writeAlias(agentsDir, "deleted", "agentId: 00000000-0000-0000-0000-00000000cccc\nruntime: claude-code\n");
    writeAlias(agentsDir, "junk", "");

    const remote: PinnedAgent[] = [
      { agentId: "00000000-0000-0000-0000-00000000aaaa", clientId: THIS_CLIENT },
      { agentId: "00000000-0000-0000-0000-00000000bbbb", clientId: OTHER_CLIENT },
    ];

    const stale = await findStaleAliases({
      agentsDir,
      clientId: THIS_CLIENT,
      listPinnedAgents: async () => remote,
    });
    const byName = Object.fromEntries(stale.map((s) => [s.name, s.reason]));
    expect(Object.keys(byName).sort()).toEqual(["deleted", "junk", "moved"]);
    expect(byName.moved).toEqual({ kind: "pinned-elsewhere", clientId: OTHER_CLIENT });
    expect(byName.deleted).toEqual({ kind: "unowned" });
    expect(byName.junk?.kind).toBe("unreadable");
  });

  it("returns empty when the agents dir does not exist", async () => {
    const stale = await findStaleAliases({
      agentsDir: join(agentsDir, "does-not-exist"),
      clientId: THIS_CLIENT,
      listPinnedAgents: async () => [],
    });
    expect(stale).toEqual([]);
  });

  it("ignores entries that vanish before stat", async (ctx) => {
    try {
      symlinkSync(join(agentsDir, "missing"), join(agentsDir, "broken-link"));
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }

    const stale = await findStaleAliases({
      agentsDir,
      clientId: THIS_CLIENT,
      listPinnedAgents: async () => [],
    });

    expect(stale).toEqual([]);
  });

  it("formats stale reasons and removes local agent footprints", () => {
    const home = mkdtempSync(join(tmpdir(), "fthub-prune-home-"));
    process.env.FIRST_TREE_HOME = home;
    mkdirSync(join(home, "config", "agents", "stale"), { recursive: true });
    mkdirSync(join(home, "data", "workspaces", "stale"), { recursive: true });
    mkdirSync(join(home, "data", "sessions"), { recursive: true });
    writeFileSync(join(home, "data", "sessions", "stale.json"), "{}");

    expect(formatStaleReason({ kind: "unreadable", error: "bad yaml" })).toBe("unreadable: bad yaml");
    expect(formatStaleReason({ kind: "unowned" })).toContain("no longer owned");
    expect(formatStaleReason({ kind: "pinned-elsewhere", clientId: OTHER_CLIENT })).toContain(OTHER_CLIENT);

    removeLocalAgent("stale");

    expect(existsSync(join(home, "config", "agents", "stale"))).toBe(false);
    expect(existsSync(join(home, "data", "workspaces", "stale"))).toBe(false);
    expect(existsSync(join(home, "data", "sessions", "stale.json"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("removeLocalAgent path safety", () => {
  let home: string;
  let outside: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "fthub-remove-home-"));
    outside = mkdtempSync(join(tmpdir(), "fthub-remove-outside-"));
    process.env.FIRST_TREE_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  function localAgentsDir(): string {
    return join(home, "config", "agents");
  }

  function seedFootprint(name: string): void {
    mkdirSync(join(localAgentsDir(), name), { recursive: true });
    writeFileSync(join(localAgentsDir(), name, "agent.yaml"), "agentId: 00000000-0000-0000-0000-000000000001\n");
    mkdirSync(join(home, "data", "workspaces", name), { recursive: true });
    writeFileSync(join(home, "data", "workspaces", name, "note.txt"), "keep");
    mkdirSync(join(home, "data", "sessions"), { recursive: true });
    writeFileSync(join(home, "data", "sessions", `${name}.json`), "{}");
  }

  it("rejects a traversal name that resolves to an existing directory outside the home", () => {
    mkdirSync(join(outside, "victim"), { recursive: true });
    writeFileSync(join(outside, "victim", "data.txt"), "keep");
    mkdirSync(localAgentsDir(), { recursive: true });
    const traversal = relative(localAgentsDir(), join(outside, "victim"));
    expect(traversal.startsWith("..")).toBe(true);
    expect(() => removeLocalAgent(traversal)).toThrow(/Invalid agent name/);
    expect(existsSync(join(outside, "victim", "data.txt"))).toBe(true);
  });

  it("rejects a session traversal name and leaves the outside json intact", () => {
    writeFileSync(join(outside, "victim.json"), "{}");
    mkdirSync(join(home, "data", "sessions"), { recursive: true });
    const traversal = relative(join(home, "data", "sessions"), join(outside, "victim"));
    expect(() => removeLocalAgent(traversal)).toThrow(/Invalid agent name/);
    expect(existsSync(join(outside, "victim.json"))).toBe(true);
  });

  it("rejects empty, dot, separator, absolute, and non-whitelist names without touching state", () => {
    seedFootprint("keeper");
    for (const name of ["", ".", "..", "a/b", "a\\b", "/etc/x", "Legit", "a.b", "a".repeat(101)]) {
      expect(() => removeLocalAgent(name)).toThrow(/Invalid agent name/);
    }
    expect(existsSync(join(localAgentsDir(), "keeper"))).toBe(true);
    expect(existsSync(join(home, "data", "workspaces", "keeper"))).toBe(true);
    expect(existsSync(join(home, "data", "sessions", "keeper.json"))).toBe(true);
  });

  it("removes grandfathered names the create-side regex would reject", () => {
    for (const name of ["_legacy", "-legacy", "a".repeat(100)]) {
      seedFootprint(name);
      removeLocalAgent(name);
      expect(existsSync(join(localAgentsDir(), name))).toBe(false);
      expect(existsSync(join(home, "data", "workspaces", name))).toBe(false);
      expect(existsSync(join(home, "data", "sessions", `${name}.json`))).toBe(false);
    }
  });

  it("is a no-op for a valid name when base dirs or targets are missing", () => {
    expect(() => removeLocalAgent("ghost")).not.toThrow();
    mkdirSync(localAgentsDir(), { recursive: true });
    expect(() => removeLocalAgent("ghost")).not.toThrow();
  });

  it("still removes a dangling symlink alias", (ctx) => {
    mkdirSync(localAgentsDir(), { recursive: true });
    try {
      symlinkSync(join(outside, "gone"), join(localAgentsDir(), "dangling"));
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }
    expect(() => removeLocalAgent("dangling")).not.toThrow();
    expect(readdirSync(localAgentsDir())).not.toContain("dangling");
  });

  it("removes an alias symlink without following it to the real dir inside the base", (ctx) => {
    seedFootprint("real");
    try {
      symlinkSync(join(localAgentsDir(), "real"), join(localAgentsDir(), "alias"));
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }
    removeLocalAgent("alias");
    expect(readdirSync(localAgentsDir())).not.toContain("alias");
    expect(existsSync(join(localAgentsDir(), "real", "agent.yaml"))).toBe(true);
  });

  it("refuses an alias symlink that resolves outside First Tree state", (ctx) => {
    mkdirSync(localAgentsDir(), { recursive: true });
    mkdirSync(join(outside, "target"), { recursive: true });
    writeFileSync(join(outside, "target", "data.txt"), "keep");
    try {
      symlinkSync(join(outside, "target"), join(localAgentsDir(), "escape"));
    } catch {
      ctx.skip("Symlink creation is not supported in this environment.");
    }
    expect(() => removeLocalAgent("escape")).toThrow('Refusing to remove "escape": resolves outside First Tree state');
    expect(existsSync(join(outside, "target", "data.txt"))).toBe(true);
    expect(readdirSync(localAgentsDir())).toContain("escape");
  });
});
