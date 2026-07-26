import { SdkError } from "@first-tree/client";
import { describe, expect, it, vi } from "vitest";
import { AuthRefreshFailedError } from "../core/bootstrap.js";
import {
  ContextTreeUpdateFailedError,
  classifyContextTreeUpdateError,
  InvalidContextTreeBindingInputError,
  setAgentContextTreeBinding,
  validateContextTreeBindingInput,
} from "../core/context-tree-binding-write.js";

const REPO = "git@github.com:acme/context-tree.git";

describe("Context Tree binding write core", () => {
  it.each([
    ["HTTPS", "https://github.com/acme/context-tree.git"],
    ["ssh URL", "ssh://git@github.com/acme/context-tree.git"],
    ["scp-like SSH", REPO],
    ["scp-like SSH alias with underscore", "git@github_internal:acme/context-tree.git"],
  ])("accepts %s repository coordinates", (_label, repo) => {
    expect(validateContextTreeBindingInput({ repo })).toEqual({ repo });
    expect(validateContextTreeBindingInput({ repo, branch: "release/v2" })).toEqual({
      repo,
      branch: "release/v2",
    });
  });

  it.each([
    "",
    "http://github.com/acme/context-tree.git",
    "git://github.com/acme/context-tree.git",
    "https://user@github.com/acme/context-tree.git",
    "ssh://git:secret@github.com/acme/context-tree.git",
    "https://github.com",
    "ssh://git@github.com/",
    "ssh:///acme/context-tree.git",
    "git@github.com:",
    " https://github.com/acme/context-tree.git",
    "https://github.com/acme/context-tree.git ",
    "https://github.com/acme/context-tree.git\nforged",
    "git@github.com:acme/context-tree.git\u0001",
    "https:/github.com/acme/context-tree.git",
    "https:///github.com/acme/context-tree.git",
    "https://github.com\\acme/context-tree.git",
    "C:\\workspace\\context-tree.git",
    "https://github.com/acme/context-tree.git?access_token=secret",
    "https://github.com/acme/context-tree.git\u2028forged",
  ])("rejects invalid repository input %j", (repo) => {
    expect(() => validateContextTreeBindingInput({ repo })).toThrowError(
      expect.objectContaining({
        code: "INVALID_CONTEXT_TREE_REPO",
        exitCode: 2,
      }),
    );
  });

  it.each([
    "",
    " main",
    "main ",
    "main\nforged",
    "main\r",
    "main\u0001",
    "HEAD",
    "--bad",
    ".hidden",
    "feature/.hidden",
    "feature..next",
    "release.lock",
    "topic~1",
    "foo//bar",
    "foo.",
    "@{-1}",
  ])("rejects invalid branch input %j", (branch) => {
    expect(() => validateContextTreeBindingInput({ repo: REPO, branch })).toThrowError(
      expect.objectContaining({
        code: "INVALID_CONTEXT_TREE_BRANCH",
        exitCode: 2,
      }),
    );
  });

  it.each([
    "main",
    "release/v2",
    "foo/-bar",
    "feature/@bar",
    "foo=bar",
    "foo!bar",
    "@",
    "foo.LOCK",
  ])("accepts Git-valid branch input %j", (branch) => {
    expect(validateContextTreeBindingInput({ repo: REPO, branch })).toEqual({ repo: REPO, branch });
  });

  it("omits branch when requested and accepts the server's preserved branch", async () => {
    const setAgentContextTreeConfig = vi.fn(async () => ({ repo: REPO, branch: "existing" }));

    await expect(
      setAgentContextTreeBinding({ agentId: "agent-1", setAgentContextTreeConfig }, { repo: REPO }),
    ).resolves.toEqual({ status: "bound", repo: REPO, branch: "existing" });

    expect(setAgentContextTreeConfig).toHaveBeenCalledOnce();
    expect(setAgentContextTreeConfig).toHaveBeenCalledWith({ repo: REPO });
  });

  it("sends an explicit branch and supports direct replacement of an existing binding", async () => {
    const replacement = "https://github.com/acme/replacement.git";
    const setAgentContextTreeConfig = vi.fn(async () => ({ repo: replacement, branch: "release" }));

    await expect(
      setAgentContextTreeBinding(
        { agentId: "agent-1", setAgentContextTreeConfig },
        { repo: replacement, branch: "release" },
      ),
    ).resolves.toEqual({ status: "bound", repo: replacement, branch: "release" });

    expect(setAgentContextTreeConfig).toHaveBeenCalledWith({ repo: replacement, branch: "release" });
  });

  it.each([
    ["missing fields", {}],
    ["missing branch", { repo: REPO }],
    ["unbound", { repo: null, branch: null }],
    ["different repository", { repo: "git@github.com:acme/other.git", branch: "main" }],
    ["different explicit branch", { repo: REPO, branch: "other" }],
    ["null explicit branch", { repo: REPO, branch: null }],
    ["invalid repository", { repo: "http://github.com/acme/context-tree.git", branch: "main" }],
    ["invalid branch", { repo: REPO, branch: " main" }],
    ["Git-invalid branch", { repo: REPO, branch: "feature..next" }],
    ["unexpected field", { repo: REPO, branch: "main", version: 1 }],
  ])("rejects a %s update response", async (_label, response) => {
    const setAgentContextTreeConfig = vi.fn(async () => response);

    await expect(
      setAgentContextTreeBinding({ agentId: "agent-1", setAgentContextTreeConfig }, { repo: REPO, branch: "main" }),
    ).rejects.toMatchObject({
      code: "CONTEXT_TREE_UPDATE_FAILED",
      category: "invalid-response",
      exitCode: 1,
    });
  });

  it.each([
    {
      label: "HTTP authentication",
      error: new SdkError(401, "private authentication response"),
      expected: { category: "authentication", exitCode: 3, httpStatus: 401 },
    },
    {
      label: "refresh authentication",
      error: new AuthRefreshFailedError("private refresh response"),
      expected: { category: "authentication", exitCode: 3 },
    },
    {
      label: "missing credentials",
      error: new Error("No credentials found in private path"),
      expected: { category: "authentication", exitCode: 3 },
    },
    {
      label: "forbidden",
      error: new SdkError(403, "private authorization response"),
      expected: { category: "remote", exitCode: 1, httpStatus: 403 },
    },
    {
      label: "remote failure",
      error: new SdkError(503, "private upstream response"),
      expected: { category: "remote", exitCode: 1, httpStatus: 503 },
    },
    {
      label: "connection",
      error: new TypeError("fetch failed", { cause: Object.assign(new Error("socket"), { code: "ECONNRESET" }) }),
      expected: { category: "connection", exitCode: 6 },
    },
    {
      label: "timeout",
      error: new DOMException("request timed out", "TimeoutError"),
      expected: { category: "timeout", exitCode: 6 },
    },
    {
      label: "invalid JSON",
      error: new SyntaxError("private malformed response"),
      expected: { category: "invalid-response", exitCode: 1 },
    },
    {
      label: "invalid JSON mentioning timeout",
      error: new SyntaxError('Unexpected token, "timeout" is not valid JSON'),
      expected: { category: "invalid-response", exitCode: 1 },
    },
    {
      label: "invalid JSON mentioning connection",
      error: new SyntaxError('Unexpected token, "fetch failed" is not valid JSON'),
      expected: { category: "invalid-response", exitCode: 1 },
    },
    {
      label: "invalid JSON mentioning authentication",
      error: new SyntaxError('Unexpected token, "authentication failed" is not valid JSON'),
      expected: { category: "invalid-response", exitCode: 1 },
    },
  ])("classifies $label without exposing source details", ({ error, expected }) => {
    const classified = classifyContextTreeUpdateError(error);
    expect(classified).toMatchObject({ code: "CONTEXT_TREE_UPDATE_FAILED", ...expected });
    expect(classified.message).not.toContain(error.message);
  });

  it.each([
    new SdkError(503, "private upstream response"),
    new TypeError("fetch failed", { cause: Object.assign(new Error("socket"), { code: "ECONNRESET" }) }),
    new DOMException("request timed out", "TimeoutError"),
    new SyntaxError("private malformed response"),
  ])("directs uncertain failures to the agent-scoped read command", (error) => {
    const classified = classifyContextTreeUpdateError(error);
    expect(classified.message).toContain("Run `first-tree org context-tree` with the same agent selection");
  });

  it("logs safe phase and final-status metadata on success", async () => {
    const privateRepo = "git@private.example.com:team/context-tree.git";
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const setAgentContextTreeConfig = vi.fn(async () => ({ repo: privateRepo, branch: "main" }));

    await expect(
      setAgentContextTreeBinding(
        { agentId: "agent-uuid", setAgentContextTreeConfig },
        { repo: privateRepo },
        { agent: "writer", logger },
      ),
    ).resolves.toEqual({ status: "bound", repo: privateRepo, branch: "main" });

    expect(logger.debug.mock.calls).toEqual([
      [{ agent: "writer", phase: "update" }, "updating agent organization Context Tree binding"],
      [{ agent: "writer", status: "bound" }, "updated agent organization Context Tree binding"],
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(privateRepo);
  });

  it("logs only safe metadata on failure", async () => {
    const privateBody = "private-response-body";
    const privateRepo = "git@private.example.com:team/context-tree.git";
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const setAgentContextTreeConfig = vi.fn(async () => {
      throw new SdkError(500, privateBody);
    });

    await expect(
      setAgentContextTreeBinding(
        { agentId: "agent-uuid", setAgentContextTreeConfig },
        { repo: privateRepo },
        { agent: "writer", logger },
      ),
    ).rejects.toBeInstanceOf(ContextTreeUpdateFailedError);

    expect(logger.debug).toHaveBeenCalledWith(
      { agent: "writer", phase: "update" },
      "updating agent organization Context Tree binding",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      { category: "remote", exitCode: 1, httpStatus: 500 },
      "agent organization Context Tree binding update failed",
    );
    const logs = JSON.stringify([...logger.debug.mock.calls, ...logger.warn.mock.calls]);
    expect(logs).not.toContain(privateBody);
    expect(logs).not.toContain(privateRepo);
  });

  it("keeps local validation errors distinct from update failures", () => {
    expect(() => validateContextTreeBindingInput({ repo: "not-a-repo" })).toThrow(InvalidContextTreeBindingInputError);
  });
});
