import { MESSAGE_FORMATS } from "@first-tree/shared";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCookie, parseCookieHeader } from "../api/auth/oauth-cookie.js";
import {
  extractEventEntity,
  formatEntityTitle,
  parseFixesRefs,
  readNumber,
  readString,
  refreshEntityTitle,
} from "../api/webhooks/github-entity.js";
import { sslOptions } from "../db/connection.js";
import {
  initTelemetry,
  isTelemetryEnabled,
  parseHeaderString,
  shutdownTelemetry,
  undiciSpanNameForRequest,
  updateKnownUndiciSpanName,
} from "../observability/logfire-init.js";
import { applyLoggerConfig, createLogger, setErrorSink } from "../observability/logger.js";
import {
  attachRequestContext,
  bodyCaptureOnSendHook,
  reportErrorToRoot,
  stampAgentResource,
  stampChatResource,
  stampClientResource,
  stampOrgScope,
} from "../observability/request-context.js";
import { broadcastToAdmins, registerAdminBroadcaster, resetAdminBroadcaster } from "../services/admin-broadcast.js";
import { explainContextTreeIoDecision } from "../services/context-tree-io.js";
import { createComment, listComments, publishDocument, toDocComment } from "../services/document.js";
import { extractMentions, normalizeGithubEvent } from "../services/github-normalize.js";
import {
  ackThroughEntryIdForBoundAgents,
  backfillSilentContextForNewParticipants,
  claimBacklogForPushFair,
} from "../services/inbox.js";
import { editMessage, maybeUnwrapDoubleEncoded, preflightMessageSendIntent } from "../services/message.js";
import { verifyOAuthState } from "../services/oauth-state.js";
import { extractSummary } from "../services/session.js";
import { uuidv7 } from "../uuid.js";

type ChainRows = unknown[];

function queryChain(rows: unknown[] = []): unknown {
  const promise = Promise.resolve(rows);
  const chain = new Proxy(
    function queryProxy(): unknown {
      return chain;
    },
    {
      get: (_target, prop) => {
        if (prop === "then") return promise.then.bind(promise);
        if (prop === "catch") return promise.catch.bind(promise);
        if (prop === "finally") return promise.finally.bind(promise);
        if (prop === Symbol.iterator) return rows[Symbol.iterator].bind(rows);
        if (prop === "returning") return vi.fn(async () => rows);
        if (prop === "for") return vi.fn(() => chain);
        return vi.fn(() => chain);
      },
      apply: () => chain,
    },
  );
  return chain;
}

function queuedSelectDb(results: ChainRows[]): {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
} {
  const db = {
    select: vi.fn(() => queryChain(results.shift() ?? [])),
    update: vi.fn(() => queryChain(results.shift() ?? [])),
    insert: vi.fn(() => queryChain(results.shift() ?? [])),
    execute: vi.fn(async () => results.shift() ?? []),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return db;
}

const source = {
  kind: "github-app-installation" as const,
  installationId: 1,
  organizationId: "org_1",
};

describe("branch coverage wave2 — pure helpers", () => {
  it("covers oauth cookie parse/build edge branches", () => {
    expect(parseCookieHeader(undefined, "a")).toBeNull();
    expect(parseCookieHeader(["a=1", "b=2"], "b")).toBe("2");
    expect(parseCookieHeader("noeq; a=1; bare; c=3", "c")).toBe("3");
    expect(parseCookieHeader("x=1; y=2", "missing")).toBeNull();
    expect(buildCookie({ name: "n", value: "v", maxAge: 10, secure: true })).toContain("Secure");
    expect(buildCookie({ name: "n", value: "v", maxAge: 0, secure: false, sameSite: "Strict" })).toContain(
      "Expires=Thu, 01 Jan 1970",
    );
  });

  it("covers sslOptions RDS and invalid URL branches", () => {
    expect(sslOptions("postgres://user:pass@db.abc123.us-east-1.rds.amazonaws.com:5432/app")).toEqual({
      ssl: { rejectUnauthorized: false },
    });
    expect(sslOptions("postgres://localhost/app")).toEqual({});
    expect(sslOptions("not a url")).toEqual({});
  });

  it("covers github entity pure edge cases", () => {
    expect(readNumber(Number.NaN)).toBeNull();
    expect(readNumber("3")).toBeNull();
    expect(readNumber(3)).toBe(3);
    expect(readString("")).toBeNull();
    expect(readString("ok")).toBe("ok");

    expect(extractEventEntity("issues", null)).toBeNull();
    expect(extractEventEntity("issues", "payload")).toBeNull();
    expect(extractEventEntity("issues", { repository: { full_name: "" }, issue: { number: 1 } })).toBeNull();
    expect(extractEventEntity("issues", { repository: "not-object", issue: { number: 1 } })).toBeNull();
    expect(
      extractEventEntity("issues", {
        repository: { full_name: "o/r" },
        issue: "not-object",
      }),
    ).toBeNull();
    expect(
      extractEventEntity("issue_comment", {
        repository: { full_name: "o/r" },
        issue: { number: 2, title: null, html_url: null, pull_request: "nope" },
      }),
    ).toMatchObject({ type: "issue", key: "o/r#2" });
    expect(
      extractEventEntity("issue_comment", {
        repository: { full_name: "o/r" },
        issue: {
          number: 3,
          pull_request: { html_url: null },
          title: "",
          html_url: "https://github.com/o/r/issues/3",
        },
      }),
    ).toMatchObject({ type: "pull_request", key: "o/r#3", url: "https://github.com/o/r/issues/3" });
    expect(
      extractEventEntity("pull_request", {
        repository: { full_name: "o/r" },
        pull_request: "x",
      }),
    ).toBeNull();
    expect(
      extractEventEntity("discussion_comment", {
        repository: { full_name: "o/r" },
        discussion: { number: Number.POSITIVE_INFINITY },
      }),
    ).toBeNull();
    expect(
      extractEventEntity("commit_comment", {
        repository: { full_name: "o/r" },
        comment: { commit_id: "", html_url: "u" },
      }),
    ).toBeNull();
    expect(
      extractEventEntity("commit_comment", {
        repository: { full_name: "o/r" },
        comment: "x",
      }),
    ).toBeNull();

    expect(parseFixesRefs("Fixes #", "o/r")).toEqual([]);
    expect(formatEntityTitle({ type: "issue", key: "o/r#1", title: "" }, "issues", "opened")).toBe("Issue r#1");
    expect(refreshEntityTitle("Issue r#1: old", { type: "issue", key: "o/r#1", title: "" })).toBeNull();
    expect(refreshEntityTitle("Issue r#1: old", { type: "issue", key: "o/r#1" })).toBeNull();
    expect(refreshEntityTitle("PR r#1: old", { type: "pull_request", key: "o/r#1", title: "new" })).toBe("PR r#1: new");
    expect(refreshEntityTitle("PR r#1", { type: "pull_request", key: "o/r#1", title: "new" })).toBe("PR r#1: new");
  });

  it("covers extractSummary and extractMentions edge branches", () => {
    expect(extractSummary(null)).toBeNull();
    expect(extractSummary({ text: null })).toBeNull();
    expect(extractSummary("@only-mention")).toBeNull();
    expect(extractSummary({ text: "  hello   world  " })).toBe("hello world");
    expect(extractMentions(undefined)).toEqual([]);
    // empty capture after @ is skipped by the regex; team slash path already covered
    expect(extractMentions("ping @user1 and @user1 again")).toEqual(["user1"]);
  });

  it("covers github normalize missing body / malformed entity branches", () => {
    expect(
      normalizeGithubEvent(
        "pull_request_review_comment",
        {
          action: "created",
          sender: { login: "alice", type: "User" },
          repository: { full_name: "o/r" },
          pull_request: { number: 1, title: "t", html_url: "u", body: null },
          comment: { body: null, html_url: "cu", user: { login: "bob" } },
        },
        source,
        "d1",
      ),
    ).toMatchObject({ kind: "review_comment" });

    expect(
      normalizeGithubEvent(
        "issue_comment",
        {
          action: "created",
          sender: { login: "alice", type: "User" },
          repository: { full_name: "o/r" },
          issue: { number: 2, title: "t", html_url: "u", body: null },
          comment: { body: undefined, html_url: "cu", user: { login: "bob" } },
        },
        source,
        null,
      ),
    ).toMatchObject({ kind: "commented" });

    expect(
      normalizeGithubEvent(
        "discussion_comment",
        {
          action: "created",
          sender: { login: "alice", type: "User" },
          repository: { full_name: "o/r" },
          discussion: { number: 3, title: "t", html_url: "u", body: null },
          comment: { body: "", html_url: "cu", user: { login: "bob" } },
        },
        source,
        "d2",
      ),
    ).toMatchObject({ kind: "commented" });

    expect(
      normalizeGithubEvent(
        "pull_request_review",
        {
          action: "submitted",
          sender: { login: "alice", type: "User" },
          repository: { full_name: "o/r" },
          pull_request: { number: 4, title: "t", html_url: "u" },
          review: { body: null, state: "approved", html_url: "ru", user: { login: "bob" } },
        },
        source,
        "d3",
      ),
    ).toMatchObject({ kind: "reviewed" });

    // PR payload missing entity (no number) → null
    expect(
      normalizeGithubEvent(
        "pull_request",
        {
          action: "opened",
          sender: { login: "alice", type: "User" },
          repository: { full_name: "o/r" },
          pull_request: { title: "t" },
        },
        source,
        "d4",
      ),
    ).toBeNull();

    // duplicate involves logins first-wins
    expect(
      normalizeGithubEvent(
        "pull_request",
        {
          action: "opened",
          sender: { login: "alice", type: "User" },
          repository: { full_name: "o/r" },
          pull_request: {
            number: 9,
            title: "t",
            html_url: "u",
            body: "hey @bob",
            assignees: [{ login: "bob" }, { login: "Bob" }, "skip"],
          },
        },
        source,
        "d5",
      )?.involves,
    ).toEqual([{ githubLogin: "bob", reason: "assigned" }]);
  });

  it("covers context-tree IO decision branches for shell / invalid refs", () => {
    const bindingRepo = "https://github.com/acme/context.git";
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "codex",
        sessionEvent: { kind: "turn_end", payload: { status: "success" } },
        bindingRepo,
      }),
    ).toEqual({ recordable: false, reason: "event_kind_not_io" });

    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "codex",
        sessionEvent: {
          kind: "tool_call",
          payload: { toolUseId: "t", name: "command", status: "ok", args: { command: 12 } },
        },
        bindingRepo,
      }),
    ).toEqual({ recordable: false, reason: "unsupported_shell_command" });

    const validRef = {
      origin: "file_change" as const,
      repoUrl: bindingRepo,
      repoBranch: "main",
      repoRelativePath: "domains/a/NODE.md",
      pathKind: "file" as const,
    };

    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "codex",
        sessionEvent: {
          kind: "tool_call",
          payload: {
            toolUseId: "t1",
            name: "file_change",
            status: "ok",
            args: {},
            toolFileRefs: [{ ...validRef, repoRelativePath: "../escape.md" }],
          },
        },
        bindingRepo,
      }),
    ).toEqual({ recordable: false, reason: "ref_path_invalid" });

    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "codex",
        sessionEvent: {
          kind: "tool_call",
          payload: {
            toolUseId: "t2",
            name: "file_change",
            status: "ok",
            args: {},
            toolFileRefs: [{ ...validRef, repoUrl: "https://github.com/other/repo.git" }],
          },
        },
        bindingRepo,
      }),
    ).toEqual({ recordable: false, reason: "ref_repo_mismatch" });

    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "claude-code",
        sessionEvent: {
          kind: "tool_call",
          payload: {
            toolUseId: "t3",
            name: "Bash",
            status: "ok",
            args: { command: "cat domains/a/NODE.md" },
            toolFileRefs: [],
          },
        },
        bindingRepo,
      }),
    ).toEqual({ recordable: false, reason: "no_tool_file_refs" });

    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "codex",
        sessionEvent: {
          kind: "context_tree_usage",
          payload: { purpose: "design_decision", treeRepoUrl: bindingRepo, nodePath: "domains/a/NODE.md" },
        },
        bindingRepo,
        bindingBranch: "main",
      }),
    ).toEqual({ recordable: true });

    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "codex",
        sessionEvent: {
          kind: "tool_call",
          payload: {
            toolUseId: "t4",
            name: "file_change",
            status: "ok",
            args: {},
            toolFileRefs: [validRef],
          },
        },
        bindingRepo,
      }),
    ).toEqual({ recordable: true });
  });

  it("covers message preflight deleted recovery wording and file content branches", () => {
    const participants = [
      { agentId: "sender", name: "sender", displayName: "Sender", status: "active", type: "agent" },
      { agentId: "gone", name: "gone", displayName: "", status: "deleted", type: "agent" },
      { agentId: "sleepy", name: null, displayName: "", status: "suspended", type: "agent" },
      { agentId: "bot", name: "bot", displayName: "Bot", status: "active", type: "agent" },
    ] as const;

    expect(() =>
      preflightMessageSendIntent({
        chatId: "chat_1",
        senderId: "sender",
        senderType: "agent",
        data: {
          format: MESSAGE_FORMATS.TEXT,
          content: "hi",
          metadata: { mentions: ["gone"] },
          source: "api",
        },
        participants,
      }),
    ).toThrow("Deleted agents cannot receive new messages");

    expect(() =>
      preflightMessageSendIntent({
        chatId: "chat_1",
        senderId: "sender",
        senderType: "agent",
        data: {
          format: MESSAGE_FORMATS.TEXT,
          content: "hi",
          metadata: { mentions: ["sleepy"] },
          source: "api",
        },
        participants,
      }),
    ).toThrow("Reactivate it before sending");

    expect(() =>
      preflightMessageSendIntent({
        chatId: "chat_1",
        senderId: "sender",
        senderType: "agent",
        data: {
          format: MESSAGE_FORMATS.FILE,
          content: { not: "an-image" },
          metadata: { mentions: ["bot"] },
          source: "api",
        },
        participants,
      }),
    ).toThrow("Invalid file message content");

    expect(
      preflightMessageSendIntent({
        chatId: "chat_1",
        senderId: "sender",
        senderType: "agent",
        data: {
          format: MESSAGE_FORMATS.FILE,
          content: {
            imageId: "11111111-1111-4111-8111-111111111111",
            mimeType: "image/png",
            filename: "x.png",
          },
          metadata: { mentions: ["bot"] },
          source: "api",
        },
        participants,
      }),
    ).toMatchObject({ mentionedAgentIds: ["bot"] });

    expect(maybeUnwrapDoubleEncoded(JSON.stringify({ a: 1 }))).toBeNull();
    expect(maybeUnwrapDoubleEncoded('"plain"')).toBeNull(); // no escape
  });
});

describe("branch coverage wave2 — observability", () => {
  afterEach(() => {
    setErrorSink(null);
    applyLoggerConfig({ level: "info", format: "pretty", bridgeToSpanLevel: "error" });
    resetAdminBroadcaster();
  });

  it("forwards truncated attributes through the error sink", () => {
    const sink = vi.fn();
    setErrorSink(sink);
    applyLoggerConfig({ level: "error", format: "json", bridgeToSpanLevel: "error" });

    const log = createLogger("branch-wave2");
    const big = "x".repeat(3000);
    const hugeObj = { nested: "y".repeat(9000) };
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    log.error(
      {
        msg: 42,
        nullVal: null,
        undefVal: undefined,
        num: 7,
        bool: true,
        arr: ["a", "b"],
        mixedArr: [1, "a"],
        big,
        hugeObj,
        circular,
        symbolOnly: Symbol("s"),
      },
      "ignored",
    );

    expect(sink).toHaveBeenCalled();
    const [, , ctx] = sink.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(ctx.nullVal).toBeNull();
    expect(ctx.num).toBe(7);
    expect(ctx.bool).toBe(true);
    expect(ctx.arr).toEqual(["a", "b"]);
    expect(typeof ctx.big).toBe("string");
    expect(String(ctx.big)).toContain("...[truncated");
    expect(typeof ctx.hugeObj).toBe("string");
    expect(String(ctx.hugeObj)).toContain("...[truncated");
  });

  it("covers request-context span stamping with and without openTelemetry", async () => {
    const bare = {} as never;
    await attachRequestContext(bare, {} as never);
    stampOrgScope(bare, { organizationId: "o", memberId: "m", role: "admin" });
    stampAgentResource(bare, { uuid: "a", inboxId: "i", clientId: null });
    stampClientResource(bare, "c");
    stampChatResource(bare, { id: "chat", type: "group" });
    reportErrorToRoot(bare, "m", undefined);
    await expect(bodyCaptureOnSendHook(bare, { statusCode: 500 } as never, "p")).resolves.toBe("p");

    const setAttribute = vi.fn();
    const recordException = vi.fn();
    const setAttributes = vi.fn();
    const span = { setAttribute, recordException, setAttributes };
    const withSpan = {
      openTelemetry: () => ({ activeSpan: span }),
      user: { userId: "u1" },
      agent: { uuid: "a1", clientId: "c1", inboxId: "in1" },
      routeOptions: { config: { otelRecordBody: true } },
      body: { password: "secret", ok: true },
      query: { q: "1" },
    } as never;

    await attachRequestContext(withSpan, {} as never);
    stampOrgScope(withSpan, { organizationId: "o", memberId: "m", role: "member" });
    stampAgentResource(withSpan, { uuid: "a2", inboxId: "i2", clientId: "c2" });
    stampClientResource(withSpan, "c3");
    stampChatResource(withSpan, { id: "chat2", type: "dm" });
    reportErrorToRoot(withSpan, "fallback", "string-err", { k: 1 });
    reportErrorToRoot(withSpan, "fallback", new Error("e"));
    reportErrorToRoot(withSpan, "fallback", undefined);
    await bodyCaptureOnSendHook(withSpan, { statusCode: 400 } as never, "payload");
    await bodyCaptureOnSendHook(withSpan, { statusCode: 200 } as never, "payload");

    const throwingOt = {
      openTelemetry: () => {
        throw new Error("ot boom");
      },
    } as never;
    expect(() => stampClientResource(throwingOt, "c")).not.toThrow();

    const nullSpan = {
      openTelemetry: () => ({ activeSpan: null }),
    } as never;
    stampChatResource(nullSpan, { id: "x", type: "group" });
    expect(setAttribute).toHaveBeenCalled();
    expect(recordException).toHaveBeenCalled();
  });

  it("covers logfire-init pure helpers and disabled telemetry path", async () => {
    expect(parseHeaderString("")).toEqual({});
    expect(parseHeaderString("A=1, ,=bad, B=2=3")).toEqual({ A: "1", B: "2=3" });
    expect(undiciSpanNameForRequest({ method: 1, origin: "https://x", path: "/v1/chat/completions" })).toBeUndefined();
    expect(
      undiciSpanNameForRequest({ method: "  ", origin: "https://x", path: "/v1/chat/completions" }),
    ).toBeUndefined();
    expect(undiciSpanNameForRequest({ method: "post", origin: "https://x", path: "/v1/chat/completions" })).toBe(
      "POST /v1/chat/completions",
    );
    expect(undiciSpanNameForRequest({ method: "GET", origin: "https://x", path: "/not-chat" })).toBeUndefined();
    expect(undiciSpanNameForRequest({ method: "GET", origin: 1, path: "/v1/chat/completions" })).toBeUndefined();
    const updater = { updateName: vi.fn() };
    updateKnownUndiciSpanName(updater, { method: "GET", origin: "https://x", path: "/v1/chat/completions/" });
    expect(updater.updateName).toHaveBeenCalledWith("GET /v1/chat/completions");
    updateKnownUndiciSpanName(updater, { method: "GET", origin: "https://x", path: ":::bad" });

    await initTelemetry(undefined);
    expect(isTelemetryEnabled()).toBe(false);
    await initTelemetry({
      endpoint: "",
      headers: "",
      exporter: "otlp-http",
      serviceName: "s",
      environment: "t",
      sampleRate: 1,
    });
    expect(isTelemetryEnabled()).toBe(false);
    await shutdownTelemetry();
  });

  it("covers admin broadcast no-op and error swallow", () => {
    broadcastToAdmins({ a: 1 });
    registerAdminBroadcaster(() => {
      throw new Error("fanout failed");
    });
    expect(() => broadcastToAdmins({ a: 2 })).not.toThrow();
    resetAdminBroadcaster();
  });
});

describe("branch coverage wave2 — service fakes", () => {
  it("covers inbox early-return branches", async () => {
    await expect(backfillSilentContextForNewParticipants(queryChain([]) as never, "chat", [])).resolves.toBeUndefined();

    await expect(
      claimBacklogForPushFair(queuedSelectDb([]) as never, "inbox", {
        limit: 0,
        defaultPerChatLimit: 1,
        chatBudgets: [],
      }),
    ).resolves.toEqual([]);
    await expect(
      claimBacklogForPushFair(queuedSelectDb([]) as never, "inbox", {
        limit: 1,
        defaultPerChatLimit: 0,
        chatBudgets: [],
      }),
    ).resolves.toEqual([]);

    await expect(ackThroughEntryIdForBoundAgents(queuedSelectDb([]) as never, 1, [])).resolves.toEqual({
      ok: false,
      reason: "not_found_or_not_bound",
    });

    const ackDb = {
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({
          select: vi.fn(() => queryChain([{ id: 5, notify: false, chatId: null, inboxId: "i" }])),
        }),
      ),
    };
    await expect(ackThroughEntryIdForBoundAgents(ackDb as never, 5, ["i"])).resolves.toEqual({
      ok: false,
      reason: "non_notify",
    });

    const nullChatDb = {
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
        let selectCalls = 0;
        return fn({
          select: vi.fn(() => {
            selectCalls += 1;
            if (selectCalls === 1) {
              return queryChain([
                {
                  id: 9,
                  notify: true,
                  chatId: null,
                  inboxId: "i",
                  status: "delivered",
                  deliveredAt: new Date(),
                  messageId: "m",
                },
              ]);
            }
            return queryChain([
              {
                id: 9,
                notify: true,
                chatId: null,
                inboxId: "i",
                status: "delivered",
                deliveredAt: new Date(),
                messageId: "m",
              },
            ]);
          }),
          update: vi.fn(() => queryChain([{ id: 9, notify: true, chatId: null, inboxId: "i", status: "acked" }])),
        });
      }),
    };
    await expect(ackThroughEntryIdForBoundAgents(nullChatDb as never, 9, ["i"])).resolves.toMatchObject({
      ok: true,
      disposition: "acked",
    });
  });

  it("covers document publish/list/comment defensive branches via db fakes", async () => {
    const author = { kind: "human" as const, id: "h1", name: "Human" };
    const now = new Date("2026-01-01T00:00:00.000Z");
    const docRow = {
      id: "doc_1",
      organizationId: "org_1",
      slug: "s",
      title: "T",
      project: null,
      status: "draft",
      latestVersion: 1,
      createdByKind: "human",
      createdById: "h1",
      createdByName: "Human",
      createdAt: now,
      updatedAt: now,
    };

    expect(
      toDocComment({
        id: "c1",
        documentId: "doc_1",
        versionNumber: 1,
        parentId: null,
        body: "b",
        anchor: null,
        status: "open",
        authorKind: "human",
        authorId: "h1",
        authorName: "Human",
        createdAt: now,
        updatedAt: now,
      }),
    ).toMatchObject({ anchor: null, status: "open" });

    // unique violation retry path then empty insert
    let attempts = 0;
    const uniqueDb = {
      transaction: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          const err = Object.assign(new Error("dup"), { code: "23505" });
          throw err;
        }
        throw Object.assign(new Error("other"), { cause: { code: "23505" } });
      }),
    };
    // second attempt also unique → rethrows after second publishDocumentOnce... actually publishDocument only retries once
    await expect(
      publishDocument(uniqueDb as never, {
        organizationId: "org_1",
        slug: "s",
        content: "body",
        title: "T",
        ifChanged: false,
        author,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    // non-unique error rethrow
    const plainErr = new Error("db down");
    await expect(
      publishDocument(
        {
          transaction: vi.fn(async () => {
            throw plainErr;
          }),
        } as never,
        { organizationId: "org_1", slug: "s", content: "body", title: "T", ifChanged: false, author },
      ),
    ).rejects.toBe(plainErr);

    // ifChanged metadata-only update with empty returning
    const ifChangedDb = {
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          select: vi
            .fn()
            .mockReturnValueOnce(queryChain([docRow]))
            .mockReturnValueOnce(queryChain([{ content: "same" }])),
          update: vi.fn(() => queryChain([])),
          insert: vi.fn(() => queryChain([])),
        };
        return fn(tx);
      }),
    };
    await expect(
      publishDocument(ifChangedDb as never, {
        organizationId: "org_1",
        slug: "s",
        content: "same",
        ifChanged: true,
        title: "New",
        project: "p",
        status: "in_review",
        author,
      }),
    ).rejects.toThrow("doc_documents update returned no row");

    // append version empty update
    const appendDb = {
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          select: vi.fn(() => queryChain([docRow])),
          insert: vi.fn(() => queryChain([])),
          update: vi.fn(() => queryChain([])),
        };
        return fn(tx);
      }),
    };
    await expect(
      publishDocument(appendDb as never, {
        organizationId: "org_1",
        slug: "s",
        content: "new-body",
        ifChanged: false,
        author,
      }),
    ).rejects.toThrow("doc_documents update returned no row");

    // listComments with version filter
    await expect(
      listComments(queuedSelectDb([[]]) as never, docRow as never, { versionNumber: 1, status: "open" }),
    ).resolves.toEqual([]);

    // createComment empty returning
    const commentDb = {
      select: vi.fn(() => queryChain([])),
      insert: vi.fn(() => queryChain([])),
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(commentDb)),
    };
    await expect(
      createComment(commentDb as never, {
        document: docRow as never,
        body: "x",
        author,
      }),
    ).rejects.toThrow("doc_comments insert returned no row");
  });

  it("covers editMessage not-found / forbidden / empty update branches", async () => {
    await expect(editMessage(queuedSelectDb([[]]) as never, "chat", "msg", "sender", { content: "x" })).rejects.toThrow(
      'Message "msg" not found',
    );

    await expect(
      editMessage(
        queuedSelectDb([[{ id: "msg", chatId: "other", senderId: "sender", format: "text", metadata: null }]]) as never,
        "chat",
        "msg",
        "sender",
        { content: "x" },
      ),
    ).rejects.toThrow("not found in this chat");

    await expect(
      editMessage(
        queuedSelectDb([[{ id: "msg", chatId: "chat", senderId: "other", format: "text", metadata: {} }]]) as never,
        "chat",
        "msg",
        "sender",
        { content: "x" },
      ),
    ).rejects.toThrow("Only the sender can edit");

    const emptyUpdate = {
      select: vi.fn(() =>
        queryChain([{ id: "msg", chatId: "chat", senderId: "sender", format: "text", metadata: null }]),
      ),
      update: vi.fn(() => queryChain([])),
    };
    await expect(editMessage(emptyUpdate as never, "chat", "msg", "sender", { content: "hi" })).rejects.toThrow(
      "UPDATE RETURNING produced no row",
    );
  });

  it("covers oauth state payload malformation branches", async () => {
    const secret = "test-jwt-secret-key-for-vitest";
    const key = new TextEncoder().encode(secret);

    const noNonce = await new SignJWT({ next: "/x" }).setProtectedHeader({ alg: "HS256" }).sign(key);
    await expect(verifyOAuthState(secret, noNonce, "n")).rejects.toThrow("malformed");

    const badTarget = await new SignJWT({ nonce: "n", next: "/x", targetOrganizationId: 1 })
      .setProtectedHeader({ alg: "HS256" })
      .sign(key);
    await expect(verifyOAuthState(secret, badTarget, "n")).rejects.toThrow("malformed");

    const badKickoff = await new SignJWT({ nonce: "n", next: "/x", kickoffUserId: 2 })
      .setProtectedHeader({ alg: "HS256" })
      .sign(key);
    await expect(verifyOAuthState(secret, badKickoff, "n")).rejects.toThrow("malformed");
  });

  it("generates uuidv7 strings", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(id.charAt(14)).toBe("7");
  });
});
