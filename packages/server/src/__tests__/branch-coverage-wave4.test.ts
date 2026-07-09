import type { ServerConfig } from "@first-tree/shared/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer } from "../bootstrap-server.js";
import {
  bindAgentToClient,
  forceDisconnect,
  getAgentRuntimeSession,
  getClientConnection,
  hasClientConnection,
  removeClientConnection,
  sendToAgent,
  sendToClient,
  setClientConnection,
  setConnection,
  unbindAgentFromClient,
  validateAgentRuntimeSession,
} from "../services/connection-manager.js";
import { claimAndBuildForPush } from "../services/inbox.js";
import {
  ensureActiveInvitation,
  getActiveInvitation,
  previewInvitation,
  recordRedemption,
  rotateInvitation,
} from "../services/invitation.js";
import { resolvePublicUrl } from "../utils/public-url.js";

type FakeWs = {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function fakeWs(readyState = 1): FakeWs {
  return {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
  };
}

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

const baseServerConfig: ServerConfig = {
  channel: "dev",
  growth: {
    landingPagesEnabled: false,
    landingCampaignMaxAgentTurns: 1,
    landingCampaignMaxEstimatedTokens: 120_000,
    landingCampaignMaxTrialsPerUserPer24Hours: 5,
  },
  docs: { enabled: false },
  database: { url: process.env.DATABASE_URL ?? "", provider: "external" },
  server: { port: 0, host: "127.0.0.1", publicUrl: "https://first-tree.example" },
  workspace: { root: "/tmp/first-tree-test-workspaces" },
  secrets: {
    jwtSecret: "test-jwt-secret-key-for-vitest",
    encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
  auth: { accessTokenExpiry: "30m", refreshTokenExpiry: "30d", connectTokenExpiry: "10m" },
  trustProxy: false,
  connectBootstrap: {
    method: "npm",
    portableDownloadBaseUrl: "https://download.first-tree.example/releases",
  },
  observability: {
    logging: { level: "error", format: "json", bridgeToSpanLevel: "off" },
    tracing: {
      endpoint: "",
      headers: "",
      exporter: "otlp-http",
      serviceName: "t",
      environment: "test",
      sampleRate: 1,
      captureClientIp: false,
    },
  },
  runtime: {
    agentHttpTokenEnforcement: false,
    runtimeSwitchFaultInjection: false,
    pollingIntervalSeconds: 5,
    presenceCleanupSeconds: 60,
    archiveSweepIntervalSeconds: 0,
    archiveMappedIdleSeconds: 60 * 60,
    notificationWebhookUrl: undefined,
  },
  update: {
    commandVersion: "test.version",
    pollIntervalMinutes: 1440,
    registryUrl: "https://localhost.invalid",
  },
};

describe("branch coverage wave4 — connection manager", () => {
  afterEach(() => {
    // clean bindings created during tests
    for (const id of ["client_a", "client_b", "agent_1", "agent_2"]) {
      unbindAgentFromClient(id);
      removeClientConnection(id, fakeWs() as never);
    }
  });

  it("covers client bind/unbind/send and forceDisconnect branches", () => {
    const wsA = fakeWs(1);
    const wsB = fakeWs(1);
    const closed = fakeWs(3);

    setClientConnection("client_a", wsA as never);
    expect(hasClientConnection("client_a")).toBe(true);
    expect(getClientConnection("client_a")).toBe(wsA);

    // replace connection closes previous open socket and clears agents
    const token = bindAgentToClient("client_a", "agent_1");
    expect(token.length).toBeGreaterThan(10);
    setClientConnection("client_a", wsB as never);
    expect(wsA.close).toHaveBeenCalled();
    expect(getAgentRuntimeSession("agent_1")).toBeUndefined();

    setClientConnection("client_a", wsB as never);
    bindAgentToClient("client_a", "agent_1", "fixed-token");
    bindAgentToClient("client_a", "agent_2");
    // move agent_1 to another client
    setClientConnection("client_b", fakeWs(1) as never);
    bindAgentToClient("client_b", "agent_1");

    expect(sendToClient("client_a", { type: "ping" })).toBe(true);
    expect(sendToClient("missing", { type: "ping" })).toBe(false);
    setClientConnection("client_closed", closed as never);
    expect(getClientConnection("client_closed")).toBeUndefined();
    expect(sendToClient("client_closed", { type: "ping" })).toBe(false);

    expect(sendToAgent("agent_1", { type: "x" })).toBe(true);
    expect(sendToAgent("nope", { type: "x" })).toBe(false);

    expect(validateAgentRuntimeSession("agent_1", "client_b", "fixed-token")).toBe(false);
    bindAgentToClient("client_b", "agent_1", "tok");
    expect(validateAgentRuntimeSession("agent_1", "client_b", "tok")).toBe(true);
    expect(validateAgentRuntimeSession("agent_1", "client_b", "bad")).toBe(false);

    expect(unbindAgentFromClient("agent_1", "wrong")).toBe(false);
    expect(unbindAgentFromClient("agent_1", "client_b")).toBe(true);
    expect(unbindAgentFromClient("ghost")).toBe(false);

    // forceDisconnect M1 path with reason + expectedClientId mismatch
    bindAgentToClient("client_a", "agent_2");
    expect(forceDisconnect("agent_2", "admin", "wrong-client")).toBe(false);
    expect(forceDisconnect("agent_2", "admin", "client_a")).toBe(true);
    expect(wsB.send).toHaveBeenCalledWith(expect.stringContaining("agent:force_disconnect"));

    // legacy per-agent connection force disconnect
    const legacy = fakeWs(1);
    setConnection("legacy_agent", legacy as never);
    expect(forceDisconnect("legacy_agent")).toBe(true);
    expect(legacy.close).toHaveBeenCalled();
    expect(forceDisconnect("legacy_agent")).toBe(false);

    // forceDisconnect without reason omits reason field
    setClientConnection("client_a", wsB as never);
    bindAgentToClient("client_a", "agent_r");
    forceDisconnect("agent_r");
    const last = wsB.send.mock.calls.at(-1)?.[0] as string;
    expect(JSON.parse(last)).not.toHaveProperty("reason");
  });
});

describe("branch coverage wave4 — public url + invitation fakes", () => {
  it("covers resolvePublicUrl host header array and fallbacks", () => {
    const app = { config: { server: { publicUrl: "" } } } as never;
    expect(
      resolvePublicUrl(app, {
        headers: {
          "x-forwarded-proto": ["https", "http"],
          "x-forwarded-host": ["front.example", "other"],
          host: ["host.example"],
        },
        protocol: "http",
        hostname: "fallback.local",
      } as never),
    ).toBe("https://front.example");

    expect(
      resolvePublicUrl(
        { config: { server: { publicUrl: undefined } } } as never,
        {
          headers: { host: "only-host" },
          protocol: "http",
          hostname: "fallback.local",
        } as never,
      ),
    ).toBe("http://only-host");

    expect(
      resolvePublicUrl(
        { config: { server: { publicUrl: "https://cfg.example/" } } } as never,
        { headers: {}, protocol: "http", hostname: "x" } as never,
      ),
    ).toBe("https://cfg.example");
  });

  it("covers invitation empty-returning and preview null expiry branches", async () => {
    await expect(getActiveInvitation(queryChain([]) as never, "org")).resolves.toBeNull();

    const existing = { id: "inv", token: "t", organizationId: "org", expiresAt: null };
    await expect(
      ensureActiveInvitation(
        {
          select: vi.fn(() => queryChain([existing])),
          insert: vi.fn(() => queryChain([])),
        } as never,
        "org",
        "member",
      ),
    ).resolves.toEqual(existing);

    await expect(
      rotateInvitation(
        {
          transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
            fn({
              update: vi.fn(() => queryChain([])),
              insert: vi.fn(() => queryChain([])),
            }),
          ),
        } as never,
        "org",
        "member",
      ),
    ).rejects.toThrow("INSERT RETURNING produced no row");

    await expect(
      previewInvitation(
        {
          select: vi
            .fn()
            .mockReturnValueOnce(queryChain([{ id: "inv", token: "t", organizationId: "org", expiresAt: null }]))
            .mockReturnValueOnce(queryChain([])),
        } as never,
        "t",
      ),
    ).rejects.toThrow("Invitation organization not found");

    await expect(
      previewInvitation(
        {
          select: vi
            .fn()
            .mockReturnValueOnce(
              queryChain([{ id: "inv", token: "t", organizationId: "org", expiresAt: new Date("2026-01-01") }]),
            )
            .mockReturnValueOnce(queryChain([{ id: "org", name: "o", displayName: "O" }])),
        } as never,
        "t",
      ),
    ).resolves.toMatchObject({ expiresAt: "2026-01-01T00:00:00.000Z" });

    await expect(
      previewInvitation(
        {
          select: vi
            .fn()
            .mockReturnValueOnce(queryChain([{ id: "inv", token: "t", organizationId: "org", expiresAt: null }]))
            .mockReturnValueOnce(queryChain([{ id: "org", name: "o", displayName: "O" }])),
        } as never,
        "t",
      ),
    ).resolves.toMatchObject({ expiresAt: null });

    await expect(
      recordRedemption(
        {
          insert: vi.fn(() => queryChain([])),
        } as never,
        { invitationId: "inv", userId: "u", ip: undefined, userAgent: undefined },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("branch coverage wave4 — inbox claim empty", () => {
  it("covers claimAndBuildForPush empty selection", async () => {
    const db = {
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
        fn({
          select: vi.fn(() => queryChain([])),
          update: vi.fn(() => queryChain([])),
        }),
      ),
    };
    await expect(claimAndBuildForPush(db as never, "in", "msg")).resolves.toEqual([]);
  });
});

describe("branch coverage wave4 — bootstrap default dependency branches", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses default randomUUID/initTelemetry/markReady/shutdownTelemetry when omitted", async () => {
    const listenFn = vi.fn(async () => "http://127.0.0.1:0");
    const closeFn = vi.fn(async () => undefined);
    const buildAppFn = vi.fn(async () => ({ listen: listenFn, close: closeFn }));
    const runMigrationsFn = vi.fn(async () => 0);

    const handlers = new Map<string, (...args: unknown[]) => void>();
    const processOn = vi.fn((event: string | symbol, handler: (...args: unknown[]) => void) => {
      handlers.set(String(event), handler);
      return fakeProcess;
    });
    const processExit = vi.fn();
    const fakeProcess = Object.assign(Object.create(process), {
      on: processOn,
      exit: processExit,
    }) as NodeJS.Process;

    vi.stubGlobal("process", fakeProcess);

    await startServer({
      initServerConfig: async () => baseServerConfig,
      // omit randomUUID / initTelemetry / markReady / shutdownTelemetry to hit ?? defaults
      runMigrations: runMigrationsFn,
      buildApp: buildAppFn as never,
      webDistPath: undefined,
    });

    expect(buildAppFn).toHaveBeenCalled();
    expect(runMigrationsFn).toHaveBeenCalled();

    handlers.get("SIGTERM")?.();
    await vi.waitFor(() => expect(closeFn).toHaveBeenCalled());
    await vi.waitFor(() => expect(processExit).toHaveBeenCalledWith(0));
  });
});
