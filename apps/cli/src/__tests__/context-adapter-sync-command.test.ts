import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../commands/types.js";

const mocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string) => {
    throw Object.assign(new Error(message), { code });
  }),
  result: vi.fn(),
  synchronize: vi.fn(),
  hasKnownGood: vi.fn(),
  inspectNextSession: vi.fn(),
  driver: { provider: "claude-code" as const },
}));

vi.mock("../core/output.js", () => ({ print: { fail: mocks.fail, result: mocks.result } }));
vi.mock("../core/context-integration/adapter-observation.js", () => ({
  inspectContextAdapterNextSessionObligation: mocks.inspectNextSession,
}));
vi.mock("../core/context-integration/adapter-sync.js", () => ({
  AdapterNextSessionRequiredError: class AdapterNextSessionRequiredError extends Error {},
  AdapterSyncRejectedError: class AdapterSyncRejectedError extends Error {},
  hasKnownGoodCompatibleContextAdapter: mocks.hasKnownGood,
  synchronizeContextAdapter: mocks.synchronize,
}));
vi.mock("../commands/context/shared.js", () => ({
  createContextIntegrationDriver: () => mocks.driver,
  parseContextProvider: (value: string) => value,
}));

import { runContextAdapterSync } from "../commands/context/adapter-sync.js";
import { AccountStateMutationBusyError } from "../core/context-integration/account-state-guard.js";

function context(): CommandContext {
  return {
    command: {
      opts: () => ({ provider: "claude-code", challenge: "a".repeat(48) }),
    } as unknown as Command,
    options: { json: true, debug: false, quiet: false },
  };
}

describe("context adapter-sync command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inspectNextSession.mockReturnValue(null);
    mocks.hasKnownGood.mockReturnValue(true);
  });

  it("requires a new Claude session instead of reporting currentAdapterUsable while an obligation is pending", () => {
    mocks.synchronize.mockImplementation(() => {
      throw new Error("Another First Tree account or Context state change is already running.");
    });
    mocks.inspectNextSession.mockReturnValue("standalone_repair");

    expect(() => runContextAdapterSync(context())).toThrow(
      "This Claude session cannot use the repaired First Tree Context Plugin",
    );
    expect(mocks.fail).toHaveBeenCalledWith(
      "CONTEXT_PLUGIN_RELOAD_REQUIRED",
      expect.stringContaining("Start a new Claude session"),
      2,
      { nextActions: [expect.stringContaining("Start a new Claude session")] },
    );
    expect(mocks.hasKnownGood).not.toHaveBeenCalled();
    expect(mocks.result).not.toHaveBeenCalled();
  });

  it("fails closed when repair holds the account lock before writing its next-session obligation", () => {
    mocks.synchronize.mockImplementation(() => {
      throw new AccountStateMutationBusyError();
    });
    mocks.inspectNextSession.mockReturnValue(null);

    expect(() => runContextAdapterSync(context())).toThrow("Start a new Claude session");
    expect(mocks.fail).toHaveBeenCalledWith(
      "CONTEXT_PLUGIN_RELOAD_REQUIRED",
      expect.stringContaining("Start a new Claude session"),
      2,
      { nextActions: [expect.stringContaining("Start a new Claude session")] },
    );
    expect(mocks.hasKnownGood).not.toHaveBeenCalled();
    expect(mocks.result).not.toHaveBeenCalled();
  });

  it("does not misclassify a non-busy lock I/O failure as next-session recovery", () => {
    const ioError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    mocks.synchronize.mockImplementation(() => {
      throw ioError;
    });
    mocks.inspectNextSession.mockReturnValue(null);

    expect(() => runContextAdapterSync(context())).not.toThrow();
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.hasKnownGood).toHaveBeenCalledWith(mocks.driver);
    expect(mocks.result).toHaveBeenCalledWith(
      expect.objectContaining({ updated: false, currentAdapterUsable: true, status: "update_deferred" }),
    );
  });
});
