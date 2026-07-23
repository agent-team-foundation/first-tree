import "fake-indexeddb/auto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStoreFixture,
  replaceOrganization,
  replaceStoreFixture,
  type StoreFixture,
} from "../../api/__tests__/scoped-store-fixture.js";
import { closeCoordinatorConnections, sessionErrorCodes } from "../session/index.js";

let fixture: StoreFixture | null = null;
let fixtureSequence = 0;

function base64Url(value: string): string {
  return btoa(value).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function jwt(accountId: string, kind: "access" | "refresh", marker: string): string {
  return `${base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${base64Url(
    JSON.stringify({ sub: accountId, type: kind, exp: 2_100_000_000, marker }),
  )}.signature`;
}

function productionTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") files.push(...productionTypeScriptFiles(path));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(path);
    }
  }
  return files;
}

const FORBIDDEN_COORDINATOR_HTTP_IDENTIFIERS = new Set([
  "requestActiveHttp",
  "refreshAccountCredential",
  "retireActiveHttpAfterTerminal401",
]);

function forbiddenCoordinatorHttpReferences(path: string, source: string): string[] {
  const scriptKind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  const references: string[] = [];
  const visit = (node: ts.Node): void => {
    const name = ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
    if (name !== undefined && FORBIDDEN_COORDINATOR_HTTP_IDENTIFIERS.has(name)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      references.push(`${path}:${line + 1}:${character + 1}:${name}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

afterEach(() => {
  fixture?.accountController.abort();
  fixture?.dispose();
  fixture = null;
  closeCoordinatorConnections();
  vi.restoreAllMocks();
});

async function activeFixture(): Promise<
  Readonly<{
    fixture: StoreFixture;
    credential: Awaited<ReturnType<StoreFixture["coordinator"]["readActiveSession"]>>["credential"];
  }>
> {
  fixtureSequence += 1;
  const created = await createStoreFixture({
    label: `active-http-${fixtureSequence}`,
    accountId: "account-http",
    organizationId: "org-http",
  });
  fixture = created;
  const { credential } = await created.coordinator.readActiveSession();
  return { fixture: created, credential };
}

describe("coordinator-owned active HTTP", () => {
  it("has no caller-controlled raw-token dispatch surface", () => {
    const coordinatorSource = readFileSync(new URL("../session/coordinator.ts", import.meta.url), "utf8");
    const sessionBarrel = readFileSync(new URL("../session/index.ts", import.meta.url), "utf8");
    expect(coordinatorSource).not.toContain("startActiveDispatch");
    expect(coordinatorSource).not.toContain("ActiveDispatchToken");
    expect(sessionBarrel).not.toContain("ActiveHttpRequest,");
    expect(sessionBarrel).not.toContain("ActiveHttpScope,");

    const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
    const bypasses = productionTypeScriptFiles(sourceRoot)
      .filter((path) => !path.endsWith("/auth/browser-session-runtime.ts"))
      .filter((path) => !path.endsWith("/auth/session/coordinator.ts"))
      .flatMap((path) => forbiddenCoordinatorHttpReferences(path, readFileSync(path, "utf8")));
    expect(bypasses).toEqual([]);

    for (const bypass of [
      "const invoke = coordinator.requestActiveHttp.bind(coordinator);",
      "const invoke = coordinator['refreshAccountCredential'];",
      "const { retireActiveHttpAfterTerminal401: invoke } = coordinator;",
      "coordinator.requestActiveHttp.call(coordinator, input);",
    ]) {
      expect(forbiddenCoordinatorHttpReferences("synthetic-bypass.ts", bypass)).not.toEqual([]);
    }
  });

  it("keeps credential bytes and the raw Response private while returning frozen detached JSON", async () => {
    const active = await activeFixture();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/api/v1/orgs/org-http/widgets?limit=2");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toMatch(/^Bearer /u);
      expect(headers.get("x-first-tree-expected-authority")).toBe(active.fixture.activation.serverAuthority);
      expect(headers.get("x-request-id")).toBe("request-1");
      expect(init).toMatchObject({
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      expect(JSON.parse(String(init?.body))).toEqual({ name: "captured" });
      return new Response(JSON.stringify({ items: [{ id: "one" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: '"one"' },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await active.fixture.coordinator.requestActiveHttp({
      view: active.fixture.lease,
      credential: active.credential,
      scope: "selected-organization",
      path: "/orgs/org-http/widgets?limit=2",
      method: "POST",
      headers: { "X-Request-Id": "request-1" },
      body: { kind: "json", value: { name: "captured" } },
      responseType: "json",
    });

    expect(response).toMatchObject({
      status: 200,
      ok: true,
      responseType: "json",
      body: { items: [{ id: "one" }] },
    });
    expect(response.headers.etag).toBe('"one"');
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.body as object)).toBe(true);
    expect(JSON.stringify(response)).not.toContain("Bearer");
    expect(Reflect.get(response, "response")).toBeUndefined();
    expect(Reflect.get(response, "admission")).toBeUndefined();
  });

  it("snapshots path, headers, body, response type, and signal before its first await", async () => {
    const active = await activeFixture();
    const body = { label: "before" };
    const headers = { "X-Request-Id": "before" };
    const request = {
      view: active.fixture.lease,
      credential: active.credential,
      scope: "selected-organization" as const,
      path: "/orgs/org-http/snapshot",
      method: "POST" as const,
      headers,
      body: { kind: "json" as const, value: body },
      responseType: "json" as const,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("/api/v1/orgs/org-http/snapshot");
      expect(new Headers(init?.headers).get("x-request-id")).toBe("before");
      expect(JSON.parse(String(init?.body))).toEqual({ label: "before" });
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = active.fixture.coordinator.requestActiveHttp(request);
    request.path = "/orgs/other/stolen";
    headers["X-Request-Id"] = "after";
    body.label = "after";

    await expect(pending).resolves.toMatchObject({ status: 200, body: {} });
  });

  it("snapshots an immutable bounded Blob with its validated content type", async () => {
    const active = await activeFixture();
    const source = new Blob(["immutable-upload"], { type: "text/plain" });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(Blob);
      expect(init?.body).not.toBe(source);
      const captured = init?.body as Blob;
      expect(captured.size).toBe(source.size);
      expect(captured.type).toBe("image/webp");
      expect(await captured.text()).toBe("immutable-upload");
      expect(new Headers(init?.headers).get("content-type")).toBe("image/webp");
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      active.fixture.coordinator.requestActiveHttp({
        view: active.fixture.lease,
        credential: active.credential,
        scope: "selected-resource",
        path: "/agents/agent-a/avatar",
        method: "PUT",
        body: { kind: "blob", value: source, contentType: "image/webp" },
        responseType: "json",
      }),
    ).resolves.toMatchObject({ status: 200, body: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed and oversized Blob bodies before fetch", async () => {
    const active = await activeFixture();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      active.fixture.coordinator.requestActiveHttp({
        view: active.fixture.lease,
        credential: active.credential,
        scope: "selected-resource",
        path: "/agents/agent-a/avatar",
        method: "PUT",
        body: { kind: "blob", value: new Blob(["x"]), contentType: "bad\ncontent-type" },
        responseType: "json",
      }),
    ).rejects.toMatchObject({ code: sessionErrorCodes.invalidState });

    await expect(
      active.fixture.coordinator.requestActiveHttp({
        view: active.fixture.lease,
        credential: active.credential,
        scope: "selected-resource",
        path: "/agents/agent-a/avatar",
        method: "PUT",
        body: {
          kind: "blob",
          value: new Blob([new Uint8Array(16 * 1024 * 1024 + 1)]),
          contentType: "application/octet-stream",
        },
        responseType: "json",
      }),
    ).rejects.toMatchObject({ code: sessionErrorCodes.invalidState });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["count", Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`X-Header-${index}`, "x"]))],
    ["value", { "X-Large": "x".repeat(8 * 1024 + 1) }],
    [
      "total bytes",
      Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`X-Header-${index}`, "x".repeat(8_000)])),
    ],
  ])("rejects request headers that exceed the %s bound before fetch", async (_label, headers) => {
    const active = await activeFixture();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      active.fixture.coordinator.requestActiveHttp({
        view: active.fixture.lease,
        credential: active.credential,
        scope: "selected-resource",
        path: "/agents/agent-a",
        headers,
        responseType: "json",
      }),
    ).rejects.toMatchObject({ code: sessionErrorCodes.invalidState });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["absolute path", "https://evil.example/api/v1/me", undefined],
    ["network-path reference", "//evil.example/api/v1/me", undefined],
    ["path traversal", "/orgs/org-http/../other", undefined],
    ["another organization", "/orgs/org-other/widgets", undefined],
    ["refresh surface", "/auth/refresh", undefined],
    ["encoded refresh alias", "/%61uth/refresh", undefined],
    ["encoded organization-route alias", "/%6frgs/org-http/widgets", undefined],
    ["encoded organization alias", "/orgs/%6frg-http/widgets", undefined],
    [
      "GitHub installation OAuth kickoff",
      "/orgs/org-http/github-app-installation/install-url?return=%2Fsettings",
      undefined,
    ],
    ["GitHub installation Connect finalizer", "/orgs/org-http/github-app-installation/connect", undefined],
    ["GitHub installation future finalizer", "/orgs/org-http/github-app-installation/finalize", undefined],
    ["provider link OAuth kickoff", "/me/auth-providers/github/link/start", undefined],
    ["provider unlink OAuth kickoff", "/me/auth-providers/google/unlink/start", undefined],
    ["public bootstrap", "/bootstrap/config", undefined],
    ["invite capability preview", "/invitations/private-capability/preview", undefined],
    ["cache eviction", "/cache-eviction", undefined],
    ["webhook ingress", "/webhooks/github", undefined],
    ["agent API", "/agent/chats", undefined],
    ["health probe", "/health", undefined],
    ["public avatar read", "/agents/agent-a/avatar?v=1&ft_authority=tag", undefined],
    ["caller authorization", "/me/profile", { Authorization: "Bearer attacker" }],
    ["ambient cookie", "/me/profile", { Cookie: "session=attacker" }],
    ["authority override", "/me/profile", { "X-First-Tree-Expected-Authority": "https://evil.test/api/v1" }],
  ])("rejects an unsafe %s before fetch", async (_label, path, headers) => {
    const active = await activeFixture();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      active.fixture.coordinator.requestActiveHttp({
        view: active.fixture.lease,
        credential: active.credential,
        scope: "selected-resource",
        path,
        headers,
        responseType: "json",
      }),
    ).rejects.toMatchObject({ code: sessionErrorCodes.invalidState });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["401", "generation-malformed-401"],
    ["421", null],
    ["503", null],
  ] as const)("preserves a sanitized %s status when its body exceeds the caller cap", async (statusText, generation) => {
    const active = await activeFixture();
    const status = Number(statusText);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ untrusted: "oversized-secret-body" }), {
            status,
            headers: {
              "Content-Type": "application/json",
              "Content-Length": "10",
              "X-Untrusted-Metadata": "x".repeat(8 * 1024 + 1),
            },
          }),
      ),
    );
    const response = await active.fixture.coordinator.requestActiveHttp({
      view: active.fixture.lease,
      credential: active.credential,
      scope: "selected-resource",
      path: "/agents/agent-a",
      responseType: "json",
      maxResponseBytes: 1,
    });
    expect(response).toMatchObject({ status, body: null });
    expect(response.headers).toEqual({});
    expect(JSON.stringify(response)).not.toContain("oversized-secret");
    if (generation !== null) {
      await expect(active.fixture.coordinator.retireActiveHttpAfterTerminal401(response, generation)).resolves.toBe(
        "retired",
      );
    }
  });

  it.each([
    ["count", Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`X-Response-${index}`, "x"]))],
    ["value", { "X-Large": "x".repeat(8 * 1024 + 1) }],
    [
      "total bytes",
      Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`X-Response-${index}`, "x".repeat(8_000)])),
    ],
  ])("rejects a normal response whose headers exceed the %s bound", async (_label, headers) => {
    const active = await activeFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { headers: { ...headers, "Content-Type": "application/json" } })),
    );

    await expect(
      active.fixture.coordinator.requestActiveHttp({
        view: active.fixture.lease,
        credential: active.credential,
        scope: "selected-resource",
        path: "/agents/agent-a",
        responseType: "json",
      }),
    ).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });
  });

  it("does not deliver response bytes or request failures after organization replacement", async () => {
    const active = await activeFixture();
    let resolveResponse = (_response: Response): void => undefined;
    const heldResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => heldResponse),
    );

    const pending = active.fixture.coordinator.requestActiveHttp({
      view: active.fixture.lease,
      credential: active.credential,
      scope: "selected-organization",
      path: "/orgs/org-http/widgets",
      responseType: "json",
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const replacement = replaceOrganization(active.fixture, {
      label: "replacement",
      organizationId: "org-replacement",
      orgRevision: "org-revision-replacement",
    });
    fixture = replacement;
    resolveResponse(
      new Response(JSON.stringify({ secret: "old-organization" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(pending).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
  });

  it("makes stale lifecycle state dominate a late transport error", async () => {
    const active = await activeFixture();
    let rejectResponse = (_error: Error): void => undefined;
    const heldResponse = new Promise<Response>((_resolve, reject) => {
      rejectResponse = reject;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => heldResponse),
    );

    const pending = active.fixture.coordinator.requestActiveHttp({
      view: active.fixture.lease,
      credential: active.credential,
      scope: "selected-resource",
      path: "/agents/agent-a",
      responseType: "json",
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    active.fixture.accountController.abort();
    rejectResponse(new Error("transport-secret-that-must-not-cross"));

    const rejection = await pending.catch((error: unknown) => error);
    expect(rejection).toMatchObject({ code: sessionErrorCodes.staleOperation });
    expect(String(rejection)).not.toContain("transport-secret");
  });

  it("returns detached byte results and rejects an oversized response after the current-view gate", async () => {
    const active = await activeFixture();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3])))
        .mockResolvedValueOnce(
          new Response(Uint8Array.from([1, 2, 3]), {
            headers: { "Content-Length": "3" },
          }),
        ),
    );

    const bytes = await active.fixture.coordinator.requestActiveHttp({
      view: active.fixture.lease,
      credential: active.credential,
      scope: "selected-resource",
      path: "/attachments/one",
      responseType: "bytes",
      maxResponseBytes: 3,
    });
    expect(bytes).toMatchObject({ status: 200, responseType: "bytes" });
    if (bytes.responseType !== "bytes") throw new Error("Expected byte response");
    expect([...bytes.body]).toEqual([1, 2, 3]);

    await expect(
      active.fixture.coordinator.requestActiveHttp({
        view: active.fixture.lease,
        credential: active.credential,
        scope: "selected-resource",
        path: "/attachments/two",
        responseType: "bytes",
        maxResponseBytes: 2,
      }),
    ).rejects.toMatchObject({ code: sessionErrorCodes.admissionDenied });
  });

  it("rejects copied and non-401 response objects as retirement capabilities", async () => {
    const active = await activeFixture();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
        .mockResolvedValueOnce(new Response("ok", { status: 200 })),
    );
    const unauthorized = await active.fixture.coordinator.requestActiveHttp({
      view: active.fixture.lease,
      credential: active.credential,
      scope: "selected-resource",
      path: "/agents/agent-a",
      responseType: "text",
    });
    const ok = await active.fixture.coordinator.requestActiveHttp({
      view: active.fixture.lease,
      credential: active.credential,
      scope: "selected-resource",
      path: "/agents/agent-a",
      responseType: "text",
    });

    await expect(
      active.fixture.coordinator.retireActiveHttpAfterTerminal401({ ...unauthorized }, "generation-copied-401"),
    ).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    await expect(
      active.fixture.coordinator.retireActiveHttpAfterTerminal401(ok, "generation-non-401"),
    ).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
    await expect(active.fixture.coordinator.readAuthority()).resolves.toMatchObject({ mode: "active" });
  });

  it("retires an original terminal 401 exactly once", async () => {
    const active = await activeFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    const unauthorized = await active.fixture.coordinator.requestActiveHttp({
      view: active.fixture.lease,
      credential: active.credential,
      scope: "selected-resource",
      path: "/agents/agent-a",
      responseType: "text",
    });

    await expect(
      active.fixture.coordinator.retireActiveHttpAfterTerminal401(unauthorized, "generation-original-401"),
    ).resolves.toBe("retired");
    await expect(active.fixture.coordinator.readAuthority()).resolves.toMatchObject({
      mode: "retiring",
      cause: "owned_401",
      generation: "generation-original-401",
    });
    await expect(
      active.fixture.coordinator.retireActiveHttpAfterTerminal401(unauthorized, "generation-original-401-replay"),
    ).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
  });

  it.each([
    "open",
    "transaction",
  ] as const)("restores the exact terminal 401 capability after a pre-commit %s failure", async (failurePoint) => {
    const active = await activeFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    const unauthorized = await active.fixture.coordinator.requestActiveHttp({
      view: active.fixture.lease,
      credential: active.credential,
      scope: "selected-resource",
      path: "/agents/agent-a",
      responseType: "text",
    });
    if (failurePoint === "open") {
      vi.spyOn(active.fixture.factory, "open").mockImplementationOnce(() => {
        throw new Error("transient coordinator open failure");
      });
    } else {
      vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementationOnce(() => {
        throw new DOMException("transient coordinator transaction failure", "UnknownError");
      });
    }

    await expect(
      active.fixture.coordinator.retireActiveHttpAfterTerminal401(unauthorized, "generation-retryable-401"),
    ).rejects.toMatchObject({ code: sessionErrorCodes.persistenceUnavailable });
    await expect(active.fixture.coordinator.readAuthority()).resolves.toMatchObject({ mode: "active" });

    await expect(
      active.fixture.coordinator.retireActiveHttpAfterTerminal401(unauthorized, "generation-retryable-401"),
    ).resolves.toBe("retired");
    await expect(
      active.fixture.coordinator.retireActiveHttpAfterTerminal401(unauthorized, "generation-retryable-401-replay"),
    ).rejects.toMatchObject({ code: sessionErrorCodes.staleOperation });
  });

  it("lets a newer durable credential supersede an earlier terminal 401", async () => {
    const active = await activeFixture();
    const replacementAccess = jwt(active.fixture.activation.accountId, "access", "newer-credential");
    const replacementRefresh = jwt(active.fixture.activation.accountId, "refresh", "newer-credential");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ accessToken: replacementAccess, refreshToken: replacementRefresh }), {
            headers: { "Content-Type": "application/json" },
          }),
        ),
    );
    const unauthorized = await active.fixture.coordinator.requestActiveHttp({
      view: active.fixture.lease,
      credential: active.credential,
      scope: "selected-resource",
      path: "/agents/agent-a",
      responseType: "text",
    });
    const replacement = await active.fixture.coordinator.refreshActiveCredential(
      active.fixture.lease,
      active.credential,
    );

    await expect(
      active.fixture.coordinator.retireActiveHttpAfterTerminal401(unauthorized, "generation-superseded-credential"),
    ).resolves.toBe("superseded");
    await expect(active.fixture.coordinator.readActiveSession()).resolves.toMatchObject({
      credential: replacement,
    });
  });

  it("lets a newer durable session supersede an earlier terminal 401", async () => {
    const active = await activeFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    const unauthorized = await active.fixture.coordinator.requestActiveHttp({
      view: active.fixture.lease,
      credential: active.credential,
      scope: "selected-resource",
      path: "/agents/agent-a",
      responseType: "text",
    });
    const replacement = await replaceStoreFixture(active.fixture, {
      label: `active-http-replacement-${fixtureSequence}`,
      accountId: "account-replacement",
      organizationId: "org-replacement",
    });
    fixture = replacement;

    await expect(
      replacement.coordinator.retireActiveHttpAfterTerminal401(unauthorized, "generation-superseded-session"),
    ).resolves.toBe("superseded");
    await expect(replacement.coordinator.readAuthority()).resolves.toMatchObject({
      mode: "active",
      session: replacement.activation,
    });
  });
});
