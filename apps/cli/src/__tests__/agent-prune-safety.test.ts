import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isStrictPathDescendant,
  LocalAgentRemovalError,
  type LocalAgentRemovalErrorCode,
  removeLocalAgent,
} from "../core/agent-prune.js";

type AgentFootprint = {
  configuration: string;
  session: string;
  workspace: string;
};

type RegionCase = {
  key: keyof AgentFootprint;
  label: string;
  leaf(name: string): string;
  root(homePath: string): string;
  targetKind: "directory" | "file";
};

const REGION_CASES: readonly RegionCase[] = [
  {
    key: "configuration",
    label: "configuration",
    leaf: (name) => name,
    root: (homePath) => join(homePath, "config", "agents"),
    targetKind: "directory",
  },
  {
    key: "workspace",
    label: "workspace",
    leaf: (name) => name,
    root: (homePath) => join(homePath, "data", "workspaces"),
    targetKind: "directory",
  },
  {
    key: "session",
    label: "session state",
    leaf: (name) => `${name}.json`,
    root: (homePath) => join(homePath, "data", "sessions"),
    targetKind: "file",
  },
];

const originalFirstTreeHome = process.env.FIRST_TREE_HOME;
let testRoot: string;
let home: string;

function footprint(homePath: string, name: string): AgentFootprint {
  return {
    configuration: join(homePath, "config", "agents", name),
    workspace: join(homePath, "data", "workspaces", name),
    session: join(homePath, "data", "sessions", `${name}.json`),
  };
}

function createManagedRoots(homePath: string): void {
  mkdirSync(join(homePath, "config", "agents"), { recursive: true });
  mkdirSync(join(homePath, "data", "workspaces"), { recursive: true });
  mkdirSync(join(homePath, "data", "sessions"), { recursive: true });
}

function createFootprint(homePath: string, name: string): AgentFootprint {
  createManagedRoots(homePath);
  const paths = footprint(homePath, name);
  mkdirSync(paths.configuration, { recursive: true });
  writeFileSync(join(paths.configuration, "agent.yaml"), `name: ${name}\n`);
  mkdirSync(paths.workspace, { recursive: true });
  writeFileSync(join(paths.workspace, "workspace-sentinel.txt"), "workspace");
  writeFileSync(paths.session, '{"session":true}\n');
  return paths;
}

function createTargetAtRegionRoot(region: RegionCase, regionRoot: string, name: string): string {
  mkdirSync(regionRoot, { recursive: true });
  const target = join(regionRoot, region.leaf(name));
  if (region.targetKind === "directory") {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "outside-sentinel.txt"), "outside");
  } else {
    writeFileSync(target, "outside");
  }
  return target;
}

function expectFootprintExists(paths: AgentFootprint): void {
  expect(existsSync(paths.configuration)).toBe(true);
  expect(existsSync(paths.workspace)).toBe(true);
  expect(existsSync(paths.session)).toBe(true);
}

function expectFootprintMissing(paths: AgentFootprint): void {
  expect(existsSync(paths.configuration)).toBe(false);
  expect(existsSync(paths.workspace)).toBe(false);
  expect(existsSync(paths.session)).toBe(false);
}

function expectRemovalError(name: string, code: LocalAgentRemovalErrorCode): LocalAgentRemovalError {
  try {
    removeLocalAgent(name);
  } catch (error) {
    if (!(error instanceof LocalAgentRemovalError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`Expected removeLocalAgent(${JSON.stringify(name)}) to throw ${code}.`);
}

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "first-tree-agent-prune-safety-"));
  home = join(testRoot, "home");
  mkdirSync(home, { recursive: true });
  process.env.FIRST_TREE_HOME = home;
});

afterEach(() => {
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
  rmSync(testRoot, { recursive: true, force: true });
});

describe("removeLocalAgent persisted-name compatibility", () => {
  it.each([
    ["65-character grandfathered name", "a".repeat(65)],
    ["100-character grandfathered name", "b".repeat(100)],
    ["leading-hyphen grandfathered name", "-legacy"],
    ["leading-underscore grandfathered name", "_legacy"],
    ["reserved but path-safe persisted name", "admin"],
  ])("removes a %s", (_label, name) => {
    const paths = createFootprint(home, name);

    removeLocalAgent(name);

    expectFootprintMissing(paths);
    expect(existsSync(join(home, "config", "agents"))).toBe(true);
    expect(existsSync(join(home, "data", "workspaces"))).toBe(true);
    expect(existsSync(join(home, "data", "sessions"))).toBe(true);
  });

  it.each([
    ["parent traversal", ".."],
    ["101 characters", "a".repeat(101)],
    ["a dot segment", "."],
    ["an embedded dot", "alpha.beta"],
    ["a POSIX separator", "alpha/beta"],
    ["a Windows separator", "alpha\\beta"],
    ["an absolute path", join(tmpdir(), "outside-agent")],
    ["a drive path", "C:\\outside\\agent"],
    ["a UNC path", "\\\\server\\share\\agent"],
    ["uppercase ASCII", "Alpha"],
    ["Unicode", "café"],
  ])("rejects %s before any filesystem mutation", (_label, name) => {
    const protectedPaths = createFootprint(home, "protected");
    const sentinel = join(home, "config", "do-not-delete.txt");
    writeFileSync(sentinel, "protected");

    expectRemovalError(name, "INVALID_AGENT_NAME");

    expectFootprintExists(protectedPaths);
    expect(readFileSync(sentinel, "utf8")).toBe("protected");
  });
});

describe("removeLocalAgent live filesystem containment", () => {
  it("keeps neighboring agents, managed roots, and parent sentinels", () => {
    const removed = createFootprint(home, "remove-me");
    const neighbor = createFootprint(home, "keep-me");
    const sentinels = [
      join(home, "home-sentinel.txt"),
      join(home, "config", "config-sentinel.txt"),
      join(home, "data", "data-sentinel.txt"),
      join(home, "config", "agents", "agents-sentinel.txt"),
      join(home, "data", "workspaces", "workspaces-sentinel.txt"),
      join(home, "data", "sessions", "sessions-sentinel.txt"),
    ];
    for (const sentinel of sentinels) writeFileSync(sentinel, "keep");

    removeLocalAgent("remove-me");

    expectFootprintMissing(removed);
    expectFootprintExists(neighbor);
    for (const sentinel of sentinels) expect(readFileSync(sentinel, "utf8")).toBe("keep");
  });

  it.each(REGION_CASES)("treats a missing $label target as a no-op and removes the other targets", (region) => {
    const paths = createFootprint(home, "partly-missing");
    rmSync(paths[region.key], { recursive: true, force: true });

    removeLocalAgent("partly-missing");

    expectFootprintMissing(paths);
  });

  it.each(REGION_CASES)("treats a missing $label root as a no-op and removes targets in other roots", (region) => {
    const paths = createFootprint(home, "missing-root");
    const missingRoot = region.root(home);
    rmSync(missingRoot, { recursive: true, force: true });

    removeLocalAgent("missing-root");

    expect(existsSync(missingRoot)).toBe(false);
    for (const other of REGION_CASES) {
      if (other.key !== region.key) expect(existsSync(paths[other.key])).toBe(false);
    }
  });

  it.each(REGION_CASES)("rejects a $label root that is a regular file without partial deletion", (region) => {
    const paths = createFootprint(home, "file-root");
    const fileRoot = region.root(home);
    rmSync(fileRoot, { recursive: true, force: true });
    writeFileSync(fileRoot, "not a directory");

    expectRemovalError("file-root", "UNSAFE_LOCAL_AGENT_PATH");

    expect(readFileSync(fileRoot, "utf8")).toBe("not a directory");
    for (const other of REGION_CASES) {
      if (other.key !== region.key) expect(existsSync(paths[other.key])).toBe(true);
    }
  });
});

describe.skipIf(process.platform === "win32")("removeLocalAgent POSIX symlink containment", () => {
  it("rejects a dangling FIRST_TREE_HOME", () => {
    createFootprint(home, "dangling-home");
    const preservedHome = join(testRoot, "preserved-home");
    renameSync(home, preservedHome);
    symlinkSync(join(testRoot, "missing-home"), home);

    expectRemovalError("dangling-home", "LOCAL_AGENT_PATH_CHECK_FAILED");

    expect(lstatSync(home).isSymbolicLink()).toBe(true);
    expectFootprintExists(footprint(preservedHome, "dangling-home"));
  });

  it.each(REGION_CASES)("rejects a $label root symlink that resolves outside FIRST_TREE_HOME", (region) => {
    const paths = createFootprint(home, "escaped-root");
    const managedRoot = region.root(home);
    rmSync(managedRoot, { recursive: true, force: true });

    const outsideRoot = join(testRoot, `home-sibling-${region.key}`);
    const outsideTarget = createTargetAtRegionRoot(region, outsideRoot, "escaped-root");
    symlinkSync(outsideRoot, managedRoot);

    expectRemovalError("escaped-root", "UNSAFE_LOCAL_AGENT_PATH");

    expect(lstatSync(managedRoot).isSymbolicLink()).toBe(true);
    expect(existsSync(outsideTarget)).toBe(true);
    for (const other of REGION_CASES) {
      if (other.key !== region.key) expect(existsSync(paths[other.key])).toBe(true);
    }
  });

  it("rejects an in-home region redirect that could otherwise delete an entire sibling region", () => {
    createManagedRoots(home);
    const agentsRoot = join(home, "config", "agents");
    const workspacesRoot = join(home, "data", "workspaces");
    const sentinel = join(workspacesRoot, "keep-me.txt");
    writeFileSync(sentinel, "keep");
    rmSync(agentsRoot, { recursive: true });
    symlinkSync(join(home, "data"), agentsRoot);

    expectRemovalError("workspaces", "UNSAFE_LOCAL_AGENT_PATH");

    expect(lstatSync(agentsRoot).isSymbolicLink()).toBe(true);
    expect(existsSync(workspacesRoot)).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
  });

  it("rejects an ancestor redirect even when the resulting region remains inside the state home", () => {
    createManagedRoots(home);
    const configRoot = join(home, "config");
    rmSync(configRoot, { recursive: true });
    const redirectedRegion = join(home, "data", "agents");
    const redirectedTarget = join(redirectedRegion, "workspaces");
    mkdirSync(redirectedTarget, { recursive: true });
    const sentinel = join(redirectedTarget, "keep-me.txt");
    writeFileSync(sentinel, "keep");
    symlinkSync(join(home, "data"), configRoot);

    expectRemovalError("workspaces", "UNSAFE_LOCAL_AGENT_PATH");

    expect(lstatSync(configRoot).isSymbolicLink()).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
  });

  it.each(REGION_CASES)("rejects a $label target symlink that resolves outside its managed root", (region) => {
    const paths = createFootprint(home, "escaped-target");
    const managedTarget = paths[region.key];
    rmSync(managedTarget, { recursive: true, force: true });

    const outsideRoot = join(testRoot, `outside-target-${region.key}`);
    const outsideTarget = createTargetAtRegionRoot(region, outsideRoot, "escaped-target");
    symlinkSync(outsideTarget, managedTarget);

    expectRemovalError("escaped-target", "UNSAFE_LOCAL_AGENT_PATH");

    expect(lstatSync(managedTarget).isSymbolicLink()).toBe(true);
    expect(existsSync(outsideTarget)).toBe(true);
    for (const other of REGION_CASES) {
      if (other.key !== region.key) expect(existsSync(paths[other.key])).toBe(true);
    }
  });

  it.each(REGION_CASES)("removes a safe in-region $label symlink entry without deleting its referent", (region) => {
    const removed = createFootprint(home, "linked-entry");
    const referent = createFootprint(home, "referent");
    rmSync(removed[region.key], { recursive: true, force: true });
    symlinkSync(referent[region.key], removed[region.key]);

    removeLocalAgent("linked-entry");

    expectFootprintMissing(removed);
    expectFootprintExists(referent);
  });

  it.each(REGION_CASES)("rejects a $label target whose realpath is exactly the managed root", (region) => {
    const paths = createFootprint(home, "root-target");
    const managedTarget = paths[region.key];
    rmSync(managedTarget, { recursive: true, force: true });
    symlinkSync(region.root(home), managedTarget);

    expectRemovalError("root-target", "UNSAFE_LOCAL_AGENT_PATH");

    expect(lstatSync(managedTarget).isSymbolicLink()).toBe(true);
    for (const other of REGION_CASES) {
      if (other.key !== region.key) expect(existsSync(paths[other.key])).toBe(true);
    }
  });

  it.each(REGION_CASES)("rejects a dangling $label root without partial deletion", (region) => {
    const paths = createFootprint(home, "dangling-root");
    const managedRoot = region.root(home);
    rmSync(managedRoot, { recursive: true, force: true });
    symlinkSync(join(testRoot, `missing-root-${region.key}`), managedRoot);

    expectRemovalError("dangling-root", "LOCAL_AGENT_PATH_CHECK_FAILED");

    expect(lstatSync(managedRoot).isSymbolicLink()).toBe(true);
    for (const other of REGION_CASES) {
      if (other.key !== region.key) expect(existsSync(paths[other.key])).toBe(true);
    }
  });

  it.each(REGION_CASES)("rejects a dangling $label target without partial deletion", (region) => {
    const paths = createFootprint(home, "dangling-target");
    const managedTarget = paths[region.key];
    rmSync(managedTarget, { recursive: true, force: true });
    symlinkSync(join(testRoot, `missing-target-${region.key}`), managedTarget);

    expectRemovalError("dangling-target", "LOCAL_AGENT_PATH_CHECK_FAILED");

    expect(lstatSync(managedTarget).isSymbolicLink()).toBe(true);
    for (const other of REGION_CASES) {
      if (other.key !== region.key) expect(existsSync(paths[other.key])).toBe(true);
    }
  });

  it("preflights every target before deleting an earlier valid target", () => {
    const paths = createFootprint(home, "atomic-preflight");
    const outsideSessions = join(testRoot, "outside-sessions");
    const outsideSession = createTargetAtRegionRoot(REGION_CASES[2], outsideSessions, "atomic-preflight");
    rmSync(paths.session, { force: true });
    symlinkSync(outsideSession, paths.session);

    expectRemovalError("atomic-preflight", "UNSAFE_LOCAL_AGENT_PATH");

    expectFootprintExists(paths);
    expect(readFileSync(join(paths.configuration, "agent.yaml"), "utf8")).toContain("atomic-preflight");
    expect(readFileSync(join(paths.workspace, "workspace-sentinel.txt"), "utf8")).toBe("workspace");
    expect(readFileSync(outsideSession, "utf8")).toBe("outside");
  });

  it("accepts a symlinked FIRST_TREE_HOME whose managed roots remain inside its canonical target", () => {
    const realHome = join(testRoot, "real-home");
    const linkedHome = join(testRoot, "linked-home");
    mkdirSync(realHome, { recursive: true });
    symlinkSync(realHome, linkedHome);
    process.env.FIRST_TREE_HOME = linkedHome;
    const paths = createFootprint(realHome, "linked-home-agent");

    removeLocalAgent("linked-home-agent");

    expectFootprintMissing(paths);
    expect(lstatSync(linkedHome).isSymbolicLink()).toBe(true);
    expect(existsSync(realHome)).toBe(true);
  });

  it("does not follow workspace child symlinks during recursive removal", () => {
    const removed = createFootprint(home, "symlink-children");
    const neighbor = createFootprint(home, "neighbor");
    const internalTarget = join(removed.workspace, "internal-target");
    mkdirSync(internalTarget);
    writeFileSync(join(internalTarget, "internal.txt"), "internal");
    symlinkSync(internalTarget, join(removed.workspace, "internal-link"));
    symlinkSync(neighbor.workspace, join(removed.workspace, "managed-sibling-link"));

    const outsideTarget = join(testRoot, "outside-workspace");
    mkdirSync(outsideTarget);
    const outsideSentinel = join(outsideTarget, "outside.txt");
    writeFileSync(outsideSentinel, "outside");
    symlinkSync(outsideTarget, join(removed.workspace, "outside-link"));

    removeLocalAgent("symlink-children");

    expectFootprintMissing(removed);
    expectFootprintExists(neighbor);
    expect(readFileSync(outsideSentinel, "utf8")).toBe("outside");
  });
});

describe("isStrictPathDescendant with path.win32 semantics", () => {
  it.each([
    ["drive descendant", "C:\\state\\agents", "C:\\state\\agents\\alpha", true],
    ["equal path", "C:\\state\\agents", "C:\\state\\agents", false],
    ["sibling prefix", "C:\\state\\agents", "C:\\state\\agents-escape\\alpha", false],
    ["parent", "C:\\state\\agents", "C:\\state", false],
    ["cross-drive target", "C:\\state\\agents", "D:\\state\\agents\\alpha", false],
    ["UNC descendant", "\\\\server\\share\\state", "\\\\server\\share\\state\\alpha", true],
    ["UNC equal path", "\\\\server\\share\\state", "\\\\server\\share\\state", false],
    ["UNC sibling prefix", "\\\\server\\share\\state", "\\\\server\\share\\state-escape\\alpha", false],
    ["cross-share target", "\\\\server\\share\\state", "\\\\server\\other\\state\\alpha", false],
  ])("classifies %s", (_label, root, target, expected) => {
    expect(isStrictPathDescendant(root, target, win32)).toBe(expected);
  });
});
