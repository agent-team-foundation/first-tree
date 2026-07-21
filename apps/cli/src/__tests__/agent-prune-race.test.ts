import { win32 } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  lstatSync: vi.fn(),
  realpathSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: fsMocks.lstatSync,
    realpathSync: fsMocks.realpathSync,
    rmSync: fsMocks.rmSync,
  };
});

vi.mock("@first-tree/shared/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@first-tree/shared/config")>();
  return {
    ...actual,
    defaultHome: () => "/state",
  };
});

import { isStrictPathDescendant, LocalAgentRemovalError, removeLocalAgent } from "../core/agent-prune.js";

const directoryEntry = {
  isDirectory: () => true,
  isFile: () => false,
  isSymbolicLink: () => false,
};

function installRealpathSequence(replacements: ReadonlyMap<number, string>): void {
  let call = 0;
  fsMocks.realpathSync.mockImplementation((path: string) => {
    call += 1;
    return replacements.get(call) ?? path;
  });
}

function expectUnsafeRace(replacements: ReadonlyMap<number, string>): void {
  installRealpathSequence(replacements);

  const thrown = captureRemovalError();
  expect(thrown).toMatchObject({ code: "UNSAFE_LOCAL_AGENT_PATH" });
  expect(fsMocks.rmSync).not.toHaveBeenCalled();
}

function captureRemovalError(): LocalAgentRemovalError {
  let thrown: unknown;
  try {
    removeLocalAgent("alpha");
  } catch (error) {
    thrown = error;
  }

  if (!(thrown instanceof LocalAgentRemovalError)) {
    throw new Error("Expected removeLocalAgent to throw LocalAgentRemovalError.", { cause: thrown });
  }
  return thrown;
}

beforeEach(() => {
  fsMocks.lstatSync.mockReset().mockReturnValue(directoryEntry);
  fsMocks.realpathSync.mockReset();
  fsMocks.rmSync.mockReset();
});

describe("removeLocalAgent immediate revalidation", () => {
  // Calls 1–10 establish the operation home and preflight all three targets.
  // Call 11 starts the first target's immediate-before-rm revalidation.
  it("rejects a canonical home identity change after a safe global preflight", () => {
    expectUnsafeRace(
      new Map([
        [11, "/replacement-state"],
        [12, "/replacement-state/config/agents"],
        [13, "/replacement-state/config/agents/alpha"],
      ]),
    );
  });

  it("rejects a canonical region identity change even when the path still normalizes to the expected region", () => {
    expectUnsafeRace(new Map([[12, "/state/config/agents/"]]));
  });

  it("rejects a target that resolves outside its region only during immediate revalidation", () => {
    expectUnsafeRace(new Map([[13, "/outside/alpha"]]));
  });
});

describe("removeLocalAgent native error sanitization", () => {
  it.each(["EACCES", "ELOOP", "ENOTDIR"])("does not treat %s from realpath as a missing target", (code) => {
    const sensitivePath = `/private/state/${code.toLowerCase()}/alpha`;
    fsMocks.realpathSync.mockImplementation(() => {
      throw Object.assign(new Error(`realpath failed at ${sensitivePath}`), { code });
    });

    const error = captureRemovalError();

    expect(error.code).toBe("LOCAL_AGENT_PATH_CHECK_FAILED");
    expect(error.message).toContain(`(${code})`);
    expect(error.message).not.toContain(sensitivePath);
    expect(fsMocks.rmSync).not.toHaveBeenCalled();
  });

  it("sanitizes a native removal failure", () => {
    const sensitivePath = "/private/state/config/agents/alpha";
    installRealpathSequence(new Map());
    fsMocks.rmSync.mockImplementationOnce(() => {
      throw Object.assign(new Error(`rm failed at ${sensitivePath}`), { code: "EACCES" });
    });

    const error = captureRemovalError();

    expect(error.code).toBe("LOCAL_AGENT_REMOVE_FAILED");
    expect(error.message).toContain("(EACCES)");
    expect(error.message).not.toContain(sensitivePath);
  });

  it("replaces an unknown native error with a path-free summary", () => {
    const sensitivePath = "/private/state/config/agents/alpha";
    fsMocks.realpathSync.mockImplementation(() => {
      throw new Error(`unexpected failure at ${sensitivePath}`);
    });

    const error = captureRemovalError();

    expect(error.code).toBe("LOCAL_AGENT_PATH_CHECK_FAILED");
    expect(error.message).toBe("Unable to verify the local agent state home safely.");
    expect(error.message).not.toContain(sensitivePath);
  });
});

describe("isStrictPathDescendant Windows semantics", () => {
  it("accepts a child and rejects equality, sibling prefixes, drive changes, and UNC escapes", () => {
    const root = "C:\\state\\data\\workspaces";

    expect(isStrictPathDescendant(root, `${root}\\alpha`, win32)).toBe(true);
    expect(isStrictPathDescendant(root, root, win32)).toBe(false);
    expect(isStrictPathDescendant(root, "C:\\state\\data\\workspaces-elsewhere\\alpha", win32)).toBe(false);
    expect(isStrictPathDescendant(root, "D:\\state\\data\\workspaces\\alpha", win32)).toBe(false);
    expect(isStrictPathDescendant(root, "\\\\server\\share\\alpha", win32)).toBe(false);
  });
});
