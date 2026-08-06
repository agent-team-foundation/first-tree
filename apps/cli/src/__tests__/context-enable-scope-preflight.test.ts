import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchScope: vi.fn(),
}));

vi.mock("../core/context-integration/exact-root-scope.js", () => {
  class ContextRootScopeError extends Error {
    constructor(
      readonly kind: "missing" | "invalid" | "fetch",
      message: string,
    ) {
      super(message);
    }
  }
  return { ContextRootScopeError, fetchExactScope: mocks.fetchScope };
});

import {
  ContextEnableScopePreflightError,
  type ContextEnableScopePreflightErrorCode,
  preflightContextEnableScope,
} from "../core/context-integration/context-enable-scope-preflight.js";
import { ContextRootScopeError } from "../core/context-integration/exact-root-scope.js";

const binding = {
  provider: "github" as const,
  repo: "https://github.com/acme/context-tree.git",
  branch: "main",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("context enable root-SCOPE preflight", () => {
  it("accepts a member-readable binding with a valid root SCOPE", async () => {
    const getMemberContextTreeSetting = vi.fn().mockResolvedValue(binding);
    mocks.fetchScope.mockReturnValueOnce({
      commit: "a".repeat(40),
      scope: { schemaVersion: 1, relatedRepositories: [], body: "Customer operations." },
    });

    await expect(preflightContextEnableScope({ getMemberContextTreeSetting }, "org-a")).resolves.toBeUndefined();
    expect(getMemberContextTreeSetting).toHaveBeenCalledWith("org-a", { retry: false });
    expect(mocks.fetchScope).toHaveBeenCalledWith(binding);
  });

  it("rejects an invalid member binding response before fetching SCOPE", async () => {
    const error = await expectFailure(
      preflightContextEnableScope(
        { getMemberContextTreeSetting: vi.fn().mockResolvedValue({ branch: "main" }) },
        "org-a",
      ),
      "CONTEXT_ENABLE_BINDING_UNREADABLE",
    );

    expect(error.stage).toBe("binding");
    expect(error.exitCode).toBe(1);
    expect(mocks.fetchScope).not.toHaveBeenCalled();
  });

  it("returns stable binding errors for unreadable and authentication failures", async () => {
    const unreadable = await expectFailure(
      preflightContextEnableScope(
        {
          getMemberContextTreeSetting: vi
            .fn()
            .mockRejectedValue(Object.assign(new Error("private upstream detail"), { statusCode: 503 })),
        },
        "org-a",
      ),
      "CONTEXT_ENABLE_BINDING_UNREADABLE",
    );
    expect(unreadable.message).not.toContain("private upstream detail");
    expect(unreadable.stage).toBe("binding");

    const authentication = await expectFailure(
      preflightContextEnableScope(
        {
          getMemberContextTreeSetting: vi
            .fn()
            .mockRejectedValue(Object.assign(new Error("private credential detail"), { statusCode: 401 })),
        },
        "org-a",
      ),
      "CONTEXT_ENABLE_SCOPE_AUTHENTICATION_REQUIRED",
    );
    expect(authentication.message).not.toContain("private credential detail");
    expect(authentication.stage).toBe("authority");
    expect(authentication.exitCode).toBe(3);
  });

  it.each([
    ["missing", "CONTEXT_ENABLE_SCOPE_MISSING", "scope", 1],
    ["invalid", "CONTEXT_ENABLE_SCOPE_INVALID", "scope", 1],
    ["fetch", "CONTEXT_ENABLE_SCOPE_FETCH_FAILED", "fetch", 6],
  ] as const)("maps %s root SCOPE failures to the setup contract", async (kind, code, stage, exitCode) => {
    mocks.fetchScope.mockImplementationOnce(() => {
      throw new ContextRootScopeError(kind, "private exact-root detail");
    });

    const error = await expectFailure(
      preflightContextEnableScope({ getMemberContextTreeSetting: vi.fn().mockResolvedValue(binding) }, "org-a"),
      code,
    );
    expect(error.message).not.toContain("private exact-root detail");
    expect(error.stage).toBe(stage);
    expect(error.exitCode).toBe(exitCode);
  });

  it("maps unexpected exact-root failures to fetch failed", async () => {
    mocks.fetchScope.mockImplementationOnce(() => {
      throw new Error("private unexpected detail");
    });

    const error = await expectFailure(
      preflightContextEnableScope({ getMemberContextTreeSetting: vi.fn().mockResolvedValue(binding) }, "org-a"),
      "CONTEXT_ENABLE_SCOPE_FETCH_FAILED",
    );
    expect(error.message).not.toContain("private unexpected detail");
    expect(error.stage).toBe("fetch");
    expect(error.exitCode).toBe(6);
  });
});

async function expectFailure(
  promise: Promise<void>,
  code: ContextEnableScopePreflightErrorCode,
): Promise<ContextEnableScopePreflightError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ContextEnableScopePreflightError);
    if (error instanceof ContextEnableScopePreflightError) {
      expect(error.code).toBe(code);
      return error;
    }
    throw error;
  }
  throw new Error(`Expected ContextEnableScopePreflightError with code ${code}.`);
}
