import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cliFetchMock = vi.hoisted(() => vi.fn());
const ensureFreshAccessTokenMock = vi.hoisted(() => vi.fn());
const loadCredentialsMock = vi.hoisted(() => vi.fn());
const bindFeishuBotMock = vi.hoisted(() => vi.fn());
const stderrMock = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

vi.mock("../core/cli-fetch.js", () => ({
  cliFetch: cliFetchMock,
}));

vi.mock("../core/feishu.js", () => ({
  bindFeishuBot: bindFeishuBotMock,
}));

const originalFirstTreeHome = process.env.FIRST_TREE_HOME;
const originalServerUrl = process.env.FIRST_TREE_SERVER_URL;

let home: string;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetModules();
  home = join(tmpdir(), `ft-onboard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(home, "config"), { recursive: true });
  process.env.FIRST_TREE_HOME = home;
  delete process.env.FIRST_TREE_SERVER_URL;
  cliFetchMock.mockReset();
  ensureFreshAccessTokenMock.mockReset();
  loadCredentialsMock.mockReset();
  bindFeishuBotMock.mockReset();
  stderrMock.mockClear();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
  if (originalServerUrl === undefined) delete process.env.FIRST_TREE_SERVER_URL;
  else process.env.FIRST_TREE_SERVER_URL = originalServerUrl;
});

describe("onboard core", () => {
  it("persists and loads resumable onboard state", async () => {
    const { loadOnboardState, saveOnboardState } = await import("../core/onboard.js");

    expect(loadOnboardState()).toBeNull();
    saveOnboardState({ id: "kael", type: "agent", domains: "runtime,tools" });

    expect(loadOnboardState()).toEqual({ id: "kael", type: "agent", domains: "runtime,tools" });
  });

  it("checks credentials, server health, and required inputs", async () => {
    vi.doMock("../core/bootstrap.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../core/bootstrap.js")>()),
      loadCredentials: loadCredentialsMock,
    }));
    const { formatCheckReport, onboardCheck } = await import("../core/onboard.js");

    loadCredentialsMock.mockReturnValueOnce({ accessToken: "a", refreshToken: "r", serverUrl: "http://hub.test" });
    process.env.FIRST_TREE_SERVER_URL = "http://hub.test";
    cliFetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    const ok = await onboardCheck({ id: "kael", type: "agent", clientId: "client-1" });
    expect(ok.map((item) => [item.key, item.status, item.value])).toEqual([
      ["connect", "ok", "http://hub.test"],
      ["server", "ok", "http://hub.test"],
      ["server_reachable", "ok", "healthy"],
      ["id", "ok", "kael"],
      ["type", "ok", "agent"],
      ["client", "ok", "client-1"],
    ]);
    expect(formatCheckReport(ok)).toContain("Signed in");

    loadCredentialsMock.mockReturnValueOnce(null);
    delete process.env.FIRST_TREE_SERVER_URL;
    const missing = await onboardCheck({ id: "", type: "human" });
    expect(missing.map((item) => [item.key, item.status])).toEqual([
      ["connect", "missing_required"],
      ["server", "missing_required"],
      ["id", "missing_required"],
      ["type", "ok"],
    ]);
    expect(formatCheckReport(missing)).toContain("Run `first-tree login <token>` first");
  });

  it("creates agent and assistant rows, writes local config, and binds Feishu", async () => {
    vi.doMock("../core/bootstrap.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../core/bootstrap.js")>()),
      ensureFreshAccessToken: ensureFreshAccessTokenMock,
    }));
    const { onboardCreate, saveOnboardState } = await import("../core/onboard.js");

    process.env.FIRST_TREE_SERVER_URL = "http://hub.test/";
    ensureFreshAccessTokenMock.mockResolvedValue("access-1");
    cliFetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          memberships: [{ organizationId: "org-1", organizationName: "Acme" }],
          defaultOrganizationId: "org-1",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { uuid: "human-uuid", name: "gandy" }))
      .mockResolvedValueOnce(jsonResponse(200, { uuid: "assistant-uuid", name: "gandy-assistant" }));
    bindFeishuBotMock.mockResolvedValue(undefined);
    saveOnboardState({ id: "gandy" });

    await onboardCreate({
      id: "gandy",
      type: "human",
      displayName: "Gandy",
      assistant: "helper",
      role: "Lead",
      domains: "runtime, tools",
      clientId: "client-1",
      feishuBotAppId: "cli_app",
      feishuBotAppSecret: "secret",
    });

    expect(cliFetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://hub.test/api/v1/me",
      "http://hub.test/api/v1/orgs/org-1/agents",
      "http://hub.test/api/v1/orgs/org-1/agents",
    ]);
    expect(JSON.parse(String(cliFetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      name: "gandy",
      type: "human",
      displayName: "Gandy",
      delegateMention: "helper",
      metadata: { role: "Lead", domains: ["runtime", "tools"] },
    });
    expect(JSON.parse(String(cliFetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      name: "helper",
      type: "agent",
      visibility: "private",
      clientId: "client-1",
    });
    expect(bindFeishuBotMock).toHaveBeenCalledWith(
      "http://hub.test",
      "access-1",
      "assistant-uuid",
      "cli_app",
      "secret",
    );
    expect(readFileSync(join(home, "config", "agents", "gandy-assistant", "agent.yaml"), "utf8")).toContain(
      'agentId: "assistant-uuid"',
    );
    expect(readFileSync(join(home, "config", "client.yaml"), "utf8")).toContain("url: http://hub.test");
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("Onboard complete");
  });

  it("surfaces organization ambiguity and agent creation errors", async () => {
    vi.doMock("../core/bootstrap.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../core/bootstrap.js")>()),
      ensureFreshAccessToken: ensureFreshAccessTokenMock,
    }));
    const { onboardCreate } = await import("../core/onboard.js");

    process.env.FIRST_TREE_SERVER_URL = "http://hub.test";
    ensureFreshAccessTokenMock.mockResolvedValue("access-1");
    cliFetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        memberships: [
          { organizationId: "org-1", organizationName: "Acme" },
          { organizationId: "org-2", organizationName: "Other" },
        ],
      }),
    );

    await expect(onboardCreate({ id: "kael", type: "agent" })).rejects.toThrow(
      "Multiple organizations — pass --org explicitly to onboard",
    );

    cliFetchMock.mockReset();
    cliFetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { memberships: [{ organizationId: "org-1", organizationName: "Acme" }] }),
      )
      .mockResolvedValueOnce(jsonResponse(409, { error: "name already exists" }));

    await expect(onboardCreate({ id: "kael", type: "agent" })).rejects.toThrow("name already exists");
  });
});
