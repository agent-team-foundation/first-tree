import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SdkError } from "@first-tree/client";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode: number) => {
    throw new Error(`${code}:${message}:${exitCode}`);
  }),
  success: vi.fn(),
}));

const localAgentMocks = vi.hoisted(() => ({
  createSdk: vi.fn(),
  handleSdkError: vi.fn((error: unknown) => {
    throw error instanceof Error ? error : new Error(String(error));
  }),
  resolveLocalAgent: vi.fn(() => ({ serverUrl: "https://first-tree.example///" })),
}));

vi.mock("../cli/output.js", () => ({
  fail: outputMocks.fail,
  success: outputMocks.success,
}));

vi.mock("../commands/_shared/local-agent.js", () => ({
  createSdk: localAgentMocks.createSdk,
  handleSdkError: localAgentMocks.handleSdkError,
  resolveLocalAgent: localAgentMocks.resolveLocalAgent,
}));

function subcommand(parent: Command, name: string): Command {
  const found = parent.commands.find((entry) => entry.name() === name);
  if (!found) throw new Error(`Missing command ${name}`);
  return found;
}

function docSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "doc_1",
    slug: "design-doc",
    title: "Design Doc",
    project: "alpha",
    status: "draft",
    latestVersion: 3,
    openCommentCount: 2,
    createdBy: "agent_1",
    updatedAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

const originalChatId = process.env.FIRST_TREE_CHAT_ID;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FIRST_TREE_CHAT_ID = originalChatId;
});

afterEach(() => {
  if (originalChatId === undefined) {
    delete process.env.FIRST_TREE_CHAT_ID;
  } else {
    process.env.FIRST_TREE_CHAT_ID = originalChatId;
  }
});

describe("doc command helpers", () => {
  it("validates statuses, versions, and slug lookup failures before API calls proceed", async () => {
    const { parseDocCommentStatus, parseDocStatus, parseVersionNumber, resolveDocBySlug } = await import(
      "../commands/doc/_shared.js"
    );

    expect(parseDocStatus("approved")).toBe("approved");
    expect(parseDocCommentStatus("resolved")).toBe("resolved");
    expect(parseVersionNumber("12")).toBe(12);
    expect(() => parseDocStatus("done")).toThrow("INVALID_STATUS");
    expect(() => parseDocCommentStatus("closed")).toThrow("INVALID_STATUS");
    expect(() => parseVersionNumber("01")).toThrow("INVALID_VERSION");
    expect(() => parseVersionNumber("0")).toThrow("INVALID_VERSION");

    const sdk = {
      listDocs: vi.fn().mockResolvedValueOnce({ items: [docSummary({ id: "doc_found" })] }),
    };
    await expect(resolveDocBySlug(sdk as never, "design-doc")).resolves.toMatchObject({ id: "doc_found" });

    sdk.listDocs.mockResolvedValueOnce({ items: [] });
    await expect(resolveDocBySlug(sdk as never, "missing")).rejects.toThrow("DOC_NOT_FOUND");
  });

  it("registers the doc command group with every public subcommand", async () => {
    const { registerDocCommands } = await import("../commands/doc/index.js");
    const root = new Command();

    registerDocCommands(root);

    const doc = subcommand(root, "doc");
    expect(doc.commands.map((entry) => entry.name()).sort()).toEqual([
      "comment",
      "comments",
      "export",
      "get",
      "import",
      "list",
      "publish",
      "reply",
      "resolve",
      "status",
    ]);
  });
});

describe("doc command actions", () => {
  it("lists, gets, updates status, comments, replies, resolves, and lists comments through the SDK", async () => {
    const { registerDocCommentCommand } = await import("../commands/doc/comment.js");
    const { registerDocCommentsCommand } = await import("../commands/doc/comments.js");
    const { registerDocGetCommand } = await import("../commands/doc/get.js");
    const { registerDocListCommand } = await import("../commands/doc/list.js");
    const { registerDocReplyCommand } = await import("../commands/doc/reply.js");
    const { registerDocResolveCommand } = await import("../commands/doc/resolve.js");
    const { registerDocStatusCommand } = await import("../commands/doc/status.js");

    const summary = docSummary();
    const sdk = {
      createDocComment: vi.fn().mockResolvedValue({ id: "comment_2" }),
      getDoc: vi.fn().mockResolvedValue({ id: "doc_1", version: { content: "# Design" } }),
      listDocComments: vi.fn().mockResolvedValue({ items: [{ id: "comment_1" }] }),
      listDocs: vi.fn().mockResolvedValue({ items: [summary], nextCursor: null }),
      replyDocComment: vi.fn().mockResolvedValue({ id: "reply_1" }),
      setDocCommentStatus: vi.fn().mockResolvedValue({ id: "comment_1", status: "open" }),
      setDocStatus: vi.fn().mockResolvedValue({ id: "doc_1", status: "approved" }),
    };
    localAgentMocks.createSdk.mockReturnValue(sdk);

    const listRoot = new Command();
    registerDocListCommand(listRoot);
    await subcommand(listRoot, "list").parseAsync(
      ["--project", "alpha", "--status", "draft", "--limit", "25", "--cursor", "next", "--agent", "writer"],
      { from: "user" },
    );
    expect(sdk.listDocs).toHaveBeenLastCalledWith({
      project: "alpha",
      status: "draft",
      limit: 25,
      cursor: "next",
    });
    expect(localAgentMocks.createSdk).toHaveBeenLastCalledWith("writer");

    const getRoot = new Command();
    registerDocGetCommand(getRoot);
    await subcommand(getRoot, "get").parseAsync(["design-doc", "--version", "2"], { from: "user" });
    expect(sdk.getDoc).toHaveBeenCalledWith("doc_1", { version: 2 });
    await subcommand(getRoot, "get").parseAsync(["design-doc"], { from: "user" });
    expect(sdk.getDoc).toHaveBeenLastCalledWith("doc_1", undefined);

    const statusRoot = new Command();
    registerDocStatusCommand(statusRoot);
    await subcommand(statusRoot, "status").parseAsync(["design-doc"], { from: "user" });
    await subcommand(statusRoot, "status").parseAsync(["design-doc", "--set", "approved"], { from: "user" });
    expect(sdk.setDocStatus).toHaveBeenCalledWith("doc_1", "approved");

    const commentRoot = new Command();
    registerDocCommentCommand(commentRoot);
    await subcommand(commentRoot, "comment").parseAsync(
      [
        "design-doc",
        "Please clarify",
        "--quote",
        "target",
        "--prefix",
        "before",
        "--suffix",
        "after",
        "--version",
        "3",
      ],
      { from: "user" },
    );
    expect(sdk.createDocComment).toHaveBeenCalledWith("doc_1", {
      body: "Please clarify",
      versionNumber: 3,
      anchor: { exact: "target", prefix: "before", suffix: "after" },
    });
    await subcommand(commentRoot, "comment").parseAsync(["design-doc", "Document-level"], { from: "user" });
    expect(sdk.createDocComment).toHaveBeenLastCalledWith("doc_1", {
      body: "Document-level",
      versionNumber: undefined,
      anchor: undefined,
    });
    await expect(
      subcommand(commentRoot, "comment").parseAsync(["design-doc", "Bad anchor", "--prefix", "orphan"], {
        from: "user",
      }),
    ).rejects.toThrow("INVALID_ANCHOR");

    const replyRoot = new Command();
    registerDocReplyCommand(replyRoot);
    await subcommand(replyRoot, "reply").parseAsync(["comment_1", "Done"], { from: "user" });
    expect(sdk.replyDocComment).toHaveBeenCalledWith("comment_1", "Done");

    const resolveRoot = new Command();
    registerDocResolveCommand(resolveRoot);
    await subcommand(resolveRoot, "resolve").parseAsync(["comment_1", "--reopen"], { from: "user" });
    expect(sdk.setDocCommentStatus).toHaveBeenCalledWith("comment_1", "open");

    const commentsRoot = new Command();
    registerDocCommentsCommand(commentsRoot);
    await subcommand(commentsRoot, "comments").parseAsync(
      ["design-doc", "--status", "open", "--version", "3", "--agent", "reviewer"],
      { from: "user" },
    );
    expect(sdk.listDocComments).toHaveBeenCalledWith("doc_1", { status: "open", versionNumber: 3 });
    await expect(
      subcommand(commentsRoot, "comments").parseAsync(["design-doc", "--watch", "4"], { from: "user" }),
    ).rejects.toThrow("INVALID_INTERVAL");

    expect(outputMocks.success).toHaveBeenCalled();
  });

  it("routes document SDK failures through the shared error handler", async () => {
    const { registerDocCommentCommand } = await import("../commands/doc/comment.js");
    const { registerDocGetCommand } = await import("../commands/doc/get.js");
    const { registerDocListCommand } = await import("../commands/doc/list.js");
    const { registerDocPublishCommand } = await import("../commands/doc/publish.js");
    const { registerDocReplyCommand } = await import("../commands/doc/reply.js");
    const { registerDocResolveCommand } = await import("../commands/doc/resolve.js");
    const { registerDocStatusCommand } = await import("../commands/doc/status.js");
    const sdk = {
      createDocComment: vi.fn(),
      getDoc: vi.fn(),
      listDocs: vi.fn().mockRejectedValue(new Error("docs offline")),
      publishDoc: vi.fn().mockRejectedValue(new Error("publish offline")),
      replyDocComment: vi.fn().mockRejectedValue(new Error("reply offline")),
      setDocCommentStatus: vi.fn().mockRejectedValue(new Error("resolve offline")),
      setDocStatus: vi.fn(),
    };
    localAgentMocks.createSdk.mockReturnValue(sdk);

    const listRoot = new Command();
    registerDocListCommand(listRoot);
    await expect(subcommand(listRoot, "list").parseAsync([], { from: "user" })).rejects.toThrow("docs offline");

    const getRoot = new Command();
    registerDocGetCommand(getRoot);
    await expect(subcommand(getRoot, "get").parseAsync(["design-doc"], { from: "user" })).rejects.toThrow(
      "docs offline",
    );

    const statusRoot = new Command();
    registerDocStatusCommand(statusRoot);
    await expect(
      subcommand(statusRoot, "status").parseAsync(["design-doc", "--set", "approved"], { from: "user" }),
    ).rejects.toThrow("docs offline");

    const commentRoot = new Command();
    registerDocCommentCommand(commentRoot);
    await expect(
      subcommand(commentRoot, "comment").parseAsync(["design-doc", "Body"], { from: "user" }),
    ).rejects.toThrow("docs offline");

    const replyRoot = new Command();
    registerDocReplyCommand(replyRoot);
    await expect(subcommand(replyRoot, "reply").parseAsync(["comment_1", "Done"], { from: "user" })).rejects.toThrow(
      "reply offline",
    );

    const resolveRoot = new Command();
    registerDocResolveCommand(resolveRoot);
    await expect(subcommand(resolveRoot, "resolve").parseAsync(["comment_1"], { from: "user" })).rejects.toThrow(
      "resolve offline",
    );

    const base = await mkdtemp(join(tmpdir(), "cli-doc-publish-error-"));
    const file = join(base, "source.md");
    await writeFile(file, "# Source Title\n\nBody\n", "utf8");
    const publishRoot = new Command();
    registerDocPublishCommand(publishRoot);
    try {
      await expect(subcommand(publishRoot, "publish").parseAsync([file], { from: "user" })).rejects.toThrow(
        "publish offline",
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }

    expect(localAgentMocks.handleSdkError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("streams new watched doc comments and reports poll errors as NDJSON", async () => {
    const { registerDocCommentsCommand } = await import("../commands/doc/comments.js");
    const stdoutWrite = vi.spyOn(process.stdout, "write");
    const stderrWrite = vi.spyOn(process.stderr, "write");
    vi.useFakeTimers();
    const sdk = {
      listDocs: vi.fn().mockResolvedValue({ items: [docSummary()] }),
      listDocComments: vi
        .fn()
        .mockResolvedValueOnce({ items: [{ id: "comment_1", body: "existing" }] })
        .mockResolvedValueOnce({
          items: [
            { id: "comment_1", body: "existing" },
            { id: "comment_2", body: "new" },
          ],
        }),
    };
    localAgentMocks.createSdk.mockReturnValue(sdk);
    stdoutWrite.mockImplementationOnce(() => {
      throw new Error("stdout closed");
    });
    stderrWrite.mockImplementationOnce(() => {
      throw new Error("watch stopped");
    });
    const root = new Command();
    registerDocCommentsCommand(root);

    try {
      const watching = subcommand(root, "comments").parseAsync(["design-doc", "--watch", "5"], { from: "user" });
      const expectedStop = expect(watching).rejects.toThrow("watch stopped");
      await vi.advanceTimersByTimeAsync(5_000);
      await expectedStop;
      expect(sdk.listDocComments).toHaveBeenCalledTimes(2);
      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining("comment_2"));
      expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("WATCH_POLL_FAILED"));
    } finally {
      vi.useRealTimers();
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  it("uses the default watch interval and stringifies non-Error watch failures", async () => {
    const { registerDocCommentsCommand } = await import("../commands/doc/comments.js");
    const stdoutWrite = vi.spyOn(process.stdout, "write");
    const stderrWrite = vi.spyOn(process.stderr, "write");
    vi.useFakeTimers();
    const sdk = {
      listDocs: vi.fn().mockResolvedValue({ items: [docSummary()] }),
      listDocComments: vi
        .fn()
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValueOnce({ items: [{ id: "comment_default", body: "new default interval comment" }] })
        .mockRejectedValueOnce("watch string failure"),
    };
    localAgentMocks.createSdk.mockReturnValue(sdk);
    stdoutWrite.mockImplementation(() => true);
    stderrWrite.mockImplementationOnce(() => {
      throw new Error("stop default watch");
    });
    const root = new Command();
    registerDocCommentsCommand(root);

    try {
      const watching = subcommand(root, "comments").parseAsync(["design-doc", "--watch"], { from: "user" });
      const expectedStop = expect(watching).rejects.toThrow("stop default watch");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining("comment_default"));
      await vi.advanceTimersByTimeAsync(15_000);
      await expectedStop;
      expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("watch string failure"));
    } finally {
      vi.useRealTimers();
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  it("publishes markdown, reports unchanged content, and rejects unreadable or invalid input", async () => {
    const { registerDocPublishCommand } = await import("../commands/doc/publish.js");
    const base = await mkdtemp(join(tmpdir(), "cli-doc-publish-"));
    const file = join(base, "source.md");
    await writeFile(file, "# Source Title\n\nBody\n", "utf8");
    const sdk = {
      publishDoc: vi
        .fn()
        .mockResolvedValueOnce({
          slug: "custom-doc",
          version: 4,
          createdDocument: false,
          createdVersion: true,
        })
        .mockResolvedValueOnce({
          slug: "custom-doc",
          version: 4,
          createdDocument: false,
          createdVersion: false,
        }),
    };
    localAgentMocks.createSdk.mockReturnValue(sdk);
    const root = new Command();
    registerDocPublishCommand(root);

    try {
      await subcommand(root, "publish").parseAsync(
        [
          file,
          "--slug",
          "custom-doc",
          "--project",
          "alpha",
          "--note",
          "Initial",
          "--status",
          "in_review",
          "--if-changed",
          "--agent",
          "writer",
        ],
        { from: "user" },
      );
      expect(sdk.publishDoc).toHaveBeenLastCalledWith({
        slug: "custom-doc",
        title: "Source Title",
        content: "# Source Title\n\nBody\n",
        project: "alpha",
        note: "Initial",
        status: "in_review",
        ifChanged: true,
      });
      expect(outputMocks.success.mock.calls.at(-1)?.[0]).toMatchObject({
        url: "https://first-tree.example/context/docs/custom-doc",
      });

      await subcommand(root, "publish").parseAsync([file, "--slug", "custom-doc"], { from: "user" });
      expect(String(outputMocks.success.mock.calls.at(-1)?.[0].hint)).toContain("Content unchanged");

      const noHeading = join(base, "no-heading.md");
      await writeFile(noHeading, "Body without heading\n", "utf8");
      sdk.publishDoc.mockResolvedValueOnce({
        slug: "no-heading",
        version: 1,
        createdDocument: true,
        createdVersion: true,
      });
      await subcommand(root, "publish").parseAsync([noHeading], { from: "user" });
      expect(sdk.publishDoc).toHaveBeenLastCalledWith(
        expect.objectContaining({ slug: "no-heading", title: undefined, content: "Body without heading\n" }),
      );

      const invalidDerivedSlug = join(base, "---.md");
      await writeFile(invalidDerivedSlug, "# Title\n", "utf8");
      await expect(subcommand(root, "publish").parseAsync([invalidDerivedSlug], { from: "user" })).rejects.toThrow(
        "INVALID_SLUG",
      );
      await expect(
        subcommand(root, "publish").parseAsync([join(base, "missing.md")], { from: "user" }),
      ).rejects.toThrow("FILE_UNREADABLE");
      await expect(subcommand(root, "publish").parseAsync([file, "--slug", "Bad!"], { from: "user" })).rejects.toThrow(
        "INVALID_SLUG",
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("imports markdown directories and preserves partial-progress failures", async () => {
    const { registerDocImportCommand } = await import("../commands/doc/import.js");
    const base = await mkdtemp(join(tmpdir(), "cli-doc-import-"));
    await writeFile(join(base, "api.md"), "No heading body\n", "utf8");
    await writeFile(join(base, "README.md"), "# skipped\n", "utf8");
    await writeFile(join(base, "notes.txt"), "skip\n", "utf8");
    const sdk = {
      publishDoc: vi.fn().mockResolvedValueOnce({
        slug: "api",
        version: 1,
        createdDocument: true,
        createdVersion: true,
      }),
    };
    localAgentMocks.createSdk.mockReturnValue(sdk);
    const root = new Command();
    registerDocImportCommand(root);

    try {
      await subcommand(root, "import").parseAsync([base, "--dry-run", "--status", "approved"], { from: "user" });
      expect(outputMocks.success.mock.calls.at(-1)?.[0]).toMatchObject({ dryRun: true });

      await subcommand(root, "import").parseAsync([base, "--project", "alpha", "--status", "approved"], {
        from: "user",
      });
      expect(sdk.publishDoc).toHaveBeenCalledWith({
        slug: "api",
        title: "api",
        content: "No heading body\n",
        project: "alpha",
        status: "approved",
        ifChanged: true,
      });

      sdk.publishDoc.mockRejectedValueOnce(new Error("network down"));
      await expect(subcommand(root, "import").parseAsync([base], { from: "user" })).rejects.toThrow("IMPORT_PARTIAL");

      const emptyProgressBase = await mkdtemp(join(tmpdir(), "cli-doc-import-empty-progress-"));
      await writeFile(join(emptyProgressBase, "first.md"), "# First\n", "utf8");
      sdk.publishDoc.mockRejectedValueOnce("string publish failure");
      await expect(subcommand(root, "import").parseAsync([emptyProgressBase], { from: "user" })).rejects.toThrow(
        "IMPORT_PARTIAL",
      );
      expect(outputMocks.fail.mock.calls.at(-1)?.[1]).toContain("Imported before the failure: none");
      await rm(emptyProgressBase, { recursive: true, force: true });

      await expect(subcommand(root, "import").parseAsync([join(base, "missing")], { from: "user" })).rejects.toThrow(
        "DIR_UNREADABLE",
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("exports every paginated document and writes a manifest", async () => {
    const { registerDocExportCommand } = await import("../commands/doc/export.js");
    const base = await mkdtemp(join(tmpdir(), "cli-doc-export-"));
    const outDir = join(base, "out");
    const first = docSummary({ id: "doc_1", slug: "one", title: "One" });
    const second = docSummary({ id: "doc_2", slug: "two", title: "Two", status: "approved" });
    const sdk = {
      getDoc: vi
        .fn()
        .mockResolvedValueOnce({ version: { content: "# One\n" } })
        .mockResolvedValueOnce({ version: { content: "# Two\n" } }),
      listDocs: vi
        .fn()
        .mockResolvedValueOnce({ items: [first], nextCursor: "page-2" })
        .mockResolvedValueOnce({ items: [second], nextCursor: null }),
    };
    localAgentMocks.createSdk.mockReturnValue(sdk);
    const root = new Command();
    registerDocExportCommand(root);

    try {
      await subcommand(root, "export").parseAsync([outDir, "--project", "alpha", "--status", "draft"], {
        from: "user",
      });

      expect(sdk.listDocs).toHaveBeenNthCalledWith(1, {
        project: "alpha",
        status: "draft",
        limit: 200,
        cursor: undefined,
      });
      expect(sdk.listDocs).toHaveBeenNthCalledWith(2, {
        project: "alpha",
        status: "draft",
        limit: 200,
        cursor: "page-2",
      });
      await expect(readFile(join(outDir, "one.md"), "utf8")).resolves.toBe("# One\n");
      await expect(readFile(join(outDir, "two.md"), "utf8")).resolves.toBe("# Two\n");
      await expect(readFile(join(outDir, "manifest.json"), "utf8")).resolves.toContain('"slug": "one"');
      expect(outputMocks.success.mock.calls.at(-1)?.[0]).toEqual({ exported: 2, dir: outDir });

      const blocked = join(base, "blocked-file");
      await writeFile(blocked, "not a directory", "utf8");
      await expect(subcommand(root, "export").parseAsync([join(blocked, "out")], { from: "user" })).rejects.toThrow(
        "DIR_UNWRITABLE",
      );

      sdk.getDoc.mockRejectedValueOnce(new Error("download failed"));
      sdk.listDocs.mockResolvedValueOnce({ items: [first], nextCursor: null });
      await expect(subcommand(root, "export").parseAsync([join(base, "sdk-fails")], { from: "user" })).rejects.toThrow(
        "download failed",
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("github command helpers and actions", () => {
  it("registers the github command group and resolves chat ids from options or session env", async () => {
    const { registerGithubCommands } = await import("../commands/github/index.js");
    const { resolveTargetChatId } = await import("../commands/github/_shared.js");
    const root = new Command();
    registerGithubCommands(root);

    const github = subcommand(root, "github");
    expect(github.commands.map((entry) => entry.name()).sort()).toEqual([
      "context-review",
      "follow",
      "following",
      "unfollow",
    ]);
    expect(resolveTargetChatId("chat_explicit")).toBe("chat_explicit");
    process.env.FIRST_TREE_CHAT_ID = "chat_env";
    expect(resolveTargetChatId(undefined)).toBe("chat_env");
    delete process.env.FIRST_TREE_CHAT_ID;
    expect(() => resolveTargetChatId(undefined)).toThrow("NO_CHAT_CONTEXT");
  });

  it("maps typed GitHub SDK failures to actionable CLI errors", async () => {
    const { handleGithubSdkError } = await import("../commands/github/_shared.js");

    expect(() => handleGithubSdkError(new SdkError(404, "missing"))).toThrow("ENTITY_NOT_FOUND");
    expect(() => handleGithubSdkError(new SdkError(422, "no installation"))).toThrow("NO_APP_INSTALLATION");
    expect(() => handleGithubSdkError(new SdkError(503, "temporarily down"))).toThrow("GITHUB_UNAVAILABLE");
    const generic = new Error("boom");
    expect(() => handleGithubSdkError(generic)).toThrow("boom");
    expect(localAgentMocks.handleSdkError).toHaveBeenLastCalledWith(generic);
  });

  it("follows, lists, and unfollows GitHub entities with all terminal hints", async () => {
    const { registerGithubFollowCommand } = await import("../commands/github/follow.js");
    const { registerGithubFollowingCommand } = await import("../commands/github/following.js");
    const { registerGithubUnfollowCommand } = await import("../commands/github/unfollow.js");
    const sdk = {
      followGithubEntity: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          result: { status: "created", entity: { entityKey: "owner/repo#1" } },
        })
        .mockResolvedValueOnce({
          ok: true,
          result: { status: "rebound", entity: { entityKey: "owner/repo#1" } },
        })
        .mockResolvedValueOnce({
          ok: true,
          result: { status: "already_following", entity: { entityKey: "owner/repo#1" } },
        })
        .mockResolvedValueOnce({
          ok: false,
          conflict: { conflict: { chatId: "chat_other", topic: "Existing work" } },
        }),
      listChatGithubEntities: vi.fn().mockResolvedValue({ items: [{ entityKey: "owner/repo#1" }] }),
      unfollowGithubEntity: vi.fn().mockResolvedValueOnce({ removed: 0 }).mockResolvedValueOnce({ removed: 2 }),
    };
    localAgentMocks.createSdk.mockReturnValue(sdk);
    const followRoot = new Command();
    registerGithubFollowCommand(followRoot);

    await subcommand(followRoot, "follow").parseAsync(["owner/repo#1", "--chat", "chat_1"], { from: "user" });
    expect(String(outputMocks.success.mock.calls.at(-1)?.[0].hint)).toContain("Now following");
    await subcommand(followRoot, "follow").parseAsync(["owner/repo#1", "--chat", "chat_1", "--rebind"], {
      from: "user",
    });
    expect(String(outputMocks.success.mock.calls.at(-1)?.[0].hint)).toContain("Line moved");
    await subcommand(followRoot, "follow").parseAsync(["owner/repo#1", "--chat", "chat_1"], { from: "user" });
    expect(String(outputMocks.success.mock.calls.at(-1)?.[0].hint)).toContain("Already following");
    await expect(
      subcommand(followRoot, "follow").parseAsync(["owner/repo#1", "--chat", "chat_1"], { from: "user" }),
    ).rejects.toThrow("ENTITY_FOLLOWED_ELSEWHERE");
    expect(sdk.followGithubEntity).toHaveBeenNthCalledWith(2, "chat_1", { entity: "owner/repo#1", rebind: true });

    const followingRoot = new Command();
    registerGithubFollowingCommand(followingRoot);
    await subcommand(followingRoot, "following").parseAsync(["--chat", "chat_1"], { from: "user" });
    expect(sdk.listChatGithubEntities).toHaveBeenCalledWith("chat_1");

    const unfollowRoot = new Command();
    registerGithubUnfollowCommand(unfollowRoot);
    await subcommand(unfollowRoot, "unfollow").parseAsync(["owner/repo#1", "--chat", "chat_1"], { from: "user" });
    expect(String(outputMocks.success.mock.calls.at(-1)?.[0].hint)).toContain("Wasn't following");
    await subcommand(unfollowRoot, "unfollow").parseAsync(["owner/repo#1", "--chat", "chat_1"], { from: "user" });
    expect(String(outputMocks.success.mock.calls.at(-1)?.[0].hint)).toContain("Severed 2 lines");
    expect(sdk.unfollowGithubEntity).toHaveBeenCalledWith("chat_1", "owner/repo#1");
  });

  it("routes GitHub list and unfollow failures through the GitHub SDK error mapper", async () => {
    const { registerGithubFollowingCommand } = await import("../commands/github/following.js");
    const { registerGithubUnfollowCommand } = await import("../commands/github/unfollow.js");
    const sdk = {
      listChatGithubEntities: vi.fn().mockRejectedValue(new Error("github list offline")),
      unfollowGithubEntity: vi.fn().mockRejectedValue(new Error("github unfollow offline")),
    };
    localAgentMocks.createSdk.mockReturnValue(sdk);

    const followingRoot = new Command();
    registerGithubFollowingCommand(followingRoot);
    await expect(
      subcommand(followingRoot, "following").parseAsync(["--chat", "chat_1"], { from: "user" }),
    ).rejects.toThrow("github list offline");

    const unfollowRoot = new Command();
    registerGithubUnfollowCommand(unfollowRoot);
    await expect(
      subcommand(unfollowRoot, "unfollow").parseAsync(["owner/repo#1", "--chat", "chat_1"], { from: "user" }),
    ).rejects.toThrow("github unfollow offline");

    expect(localAgentMocks.handleSdkError).toHaveBeenCalledWith(expect.any(Error));
  });
});
