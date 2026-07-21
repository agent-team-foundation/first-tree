import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_RUNTIME_SESSION_HEADER, AGENT_SELECTOR_HEADER } from "@first-tree/shared";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  getClientServiceStatus: vi.fn(),
  installClientService: vi.fn(),
  isServiceSupported: vi.fn(),
  restartClientService: vi.fn(),
  startClientService: vi.fn(),
}));
const clientRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("../core/service-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/service-install.js")>()),
  ...serviceMocks,
}));
vi.mock("../core/client-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/client-runtime.js")>()),
  ClientRuntime: clientRuntimeMock,
}));

type CapturedRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
};

const originalFirstTreeHome = process.env.FIRST_TREE_HOME;
const originalServerUrl = process.env.FIRST_TREE_SERVER_URL;
const originalClientId = process.env.FIRST_TREE_CLIENT_ID;
const stdoutMock = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
const stderrMock = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
  throw new Error("process.exit");
}) as never);

let home: string;
let httpServer: HttpServer;
let serverUrl: string;
let requests: CapturedRequest[];

function jwt(payload: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function reviewMetadata(): Record<string, unknown> {
  return {
    taskType: "context_tree_pr_review",
    reviewPacketV1: {
      schemaVersion: 1,
      repository: "owner/context-tree",
      pullRequest: 749,
      expectedHead: "a".repeat(40),
      baseRef: "main",
      sourceRef: "agent-review-contract",
      requesterGithubLogin: "writer",
      goal: "Record the approved Agent Review contract.",
      source: { label: "Architecture discussion", reference: "first-tree-chat:agent-review-contract" },
      decisionSummary: "Use the existing member task Chat.",
      rationale: "This preserves the normal Chat and Inbox boundary.",
      targetPaths: ["system/context-tree-pr-reviewer.md"],
      repairScope: ["system/context-tree-pr-reviewer.md"],
      relevantContextRefs: [],
      unresolvedQuestions: [],
      verify: { status: "passed", summary: "first-tree tree verify passed" },
      evidence: [],
    },
  };
}

async function runLogin(): Promise<void> {
  const { registerLoginCommand } = await import("../commands/login.js");
  const program = new Command();
  program.exitOverride();
  registerLoginCommand(program);
  await program.parseAsync(["login", "short_code-1234567890", "--no-start"], { from: "user" });
}

async function runReviewConfig(): Promise<void> {
  const { registerOrgContextTreeCommand } = await import("../commands/org/context-tree.js");
  const program = new Command();
  program.exitOverride();
  registerOrgContextTreeCommand(program);
  await program.parseAsync(["context-tree", "review-config", "--as-member"], { from: "user" });
}

async function runMemberDispatch(metadataFile: string): Promise<void> {
  const { registerChatCreateCommand } = await import("../commands/chat/create.js");
  const program = new Command();
  program.exitOverride();
  registerChatCreateCommand(program);
  await program.parseAsync(
    [
      "create",
      "Please review this Context Tree PR.",
      "--as-member",
      "--format",
      "markdown",
      "--metadata-file",
      metadataFile,
    ],
    { from: "user" },
  );
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  stdoutMock.mockClear();
  stderrMock.mockClear();
  exitMock.mockClear();
  exitMock.mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);

  home = mkdtempSync(join(tmpdir(), "ft-member-review-login-"));
  process.env.FIRST_TREE_HOME = home;
  process.env.FIRST_TREE_CLIENT_ID = "client_c0ffee00";
  requests = [];
  const accessToken = jwt({
    sub: "user-1",
    memberId: "member-1",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });

  httpServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const path = req.url ?? "/";
    requests.push({
      method: req.method ?? "GET",
      path,
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });

    if (req.method === "POST" && path === "/api/v1/auth/connect-token") {
      jsonResponse(res, 200, { accessToken, refreshToken: "refresh-1" });
      return;
    }
    if (req.method === "GET" && path === "/api/v1/me") {
      jsonResponse(res, 200, {
        memberships: [{ organizationId: "org-1" }],
        defaultOrganizationId: "org-1",
      });
      return;
    }
    if (req.method === "GET" && path === "/api/v1/orgs/org-1/settings/context_tree") {
      jsonResponse(res, 200, { repo: "https://github.com/owner/context-tree.git", branch: "main" });
      return;
    }
    if (req.method === "GET" && path === "/api/v1/orgs/org-1/settings/context_tree_features") {
      jsonResponse(res, 200, {
        contextReviewer: {
          enabled: true,
          agentUuid: "reviewer-1",
          reviewerAgent: { uuid: "reviewer-1", name: "reviewer", displayName: "Reviewer" },
        },
      });
      return;
    }
    if (req.method === "POST" && path === "/api/v1/orgs/org-1/chats") {
      jsonResponse(res, 200, {
        chatId: "chat-review",
        messageId: "msg-review",
        topic: "Context Review · context-tree#749",
        effectiveSenderId: "human-1",
        reviewerAgentUuid: "reviewer-1",
        outcome: "created",
        managedReviewReceiptV1: {
          schemaVersion: 1,
          repository: "owner/context-tree",
          pullRequest: 749,
          expectedHead: "a".repeat(40),
        },
      });
      return;
    }
    jsonResponse(res, 404, { error: `Unexpected test request: ${req.method} ${path}` });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP address");
  serverUrl = `http://127.0.0.1:${address.port}`;
  process.env.FIRST_TREE_SERVER_URL = serverUrl;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });
  rmSync(home, { recursive: true, force: true });
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
  if (originalServerUrl === undefined) delete process.env.FIRST_TREE_SERVER_URL;
  else process.env.FIRST_TREE_SERVER_URL = originalServerUrl;
  if (originalClientId === undefined) delete process.env.FIRST_TREE_CLIENT_ID;
  else process.env.FIRST_TREE_CLIENT_ID = originalClientId;
  process.exitCode = undefined;
  const { resetConfig, resetConfigMeta } = await import("@first-tree/shared/config");
  resetConfig();
  resetConfigMeta();
});

describe("member Agent Review standard-login path", () => {
  it("runs review config and keyed dispatch without a daemon, local Agent, or runtime identity headers", async () => {
    const metadataFile = join(home, "review-packet.json");
    writeFileSync(metadataFile, JSON.stringify(reviewMetadata()));

    await runLogin();

    const credentials = JSON.parse(readFileSync(join(home, "config", "credentials.json"), "utf8")) as {
      accessToken: string;
      refreshToken: string;
      serverUrl: string;
    };
    expect(credentials).toMatchObject({ refreshToken: "refresh-1", serverUrl });
    expect(readFileSync(join(home, "config", "client.yaml"), "utf8")).toContain("id: client_c0ffee00");
    expect(existsSync(join(home, "config", "agents"))).toBe(false);
    expect(serviceMocks.isServiceSupported).not.toHaveBeenCalled();
    expect(serviceMocks.installClientService).not.toHaveBeenCalled();
    expect(serviceMocks.startClientService).not.toHaveBeenCalled();
    expect(clientRuntimeMock).not.toHaveBeenCalled();

    await runReviewConfig();
    await runMemberDispatch(metadataFile);

    const memberRequests = requests.filter((request) => request.path !== "/api/v1/auth/connect-token");
    expect(memberRequests).toHaveLength(5);
    expect(memberRequests.map((request) => `${request.method} ${request.path}`)).toEqual(
      expect.arrayContaining([
        "GET /api/v1/me",
        "GET /api/v1/orgs/org-1/settings/context_tree",
        "GET /api/v1/orgs/org-1/settings/context_tree_features",
        "POST /api/v1/orgs/org-1/chats",
      ]),
    );
    for (const request of memberRequests) {
      expect(request.headers.authorization).toBe(`Bearer ${credentials.accessToken}`);
      expect(request.headers[AGENT_SELECTOR_HEADER.toLowerCase()]).toBeUndefined();
      expect(request.headers[AGENT_RUNTIME_SESSION_HEADER.toLowerCase()]).toBeUndefined();
    }
    expect(requests.some((request) => request.path.startsWith("/api/v1/clients/"))).toBe(false);
    expect(requests.some((request) => request.path.startsWith("/api/v1/agent/"))).toBe(false);
    expect(JSON.parse(memberRequests.at(-1)?.body ?? "{}")).toMatchObject({ mode: "keyed_task" });
    expect(serviceMocks.getClientServiceStatus).not.toHaveBeenCalled();
    expect(serviceMocks.restartClientService).not.toHaveBeenCalled();
    expect(clientRuntimeMock).not.toHaveBeenCalled();
  });
});
