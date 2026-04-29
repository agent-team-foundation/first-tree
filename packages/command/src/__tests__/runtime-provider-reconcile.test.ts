import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { reconcileLocalRuntimeProviders, uploadClientCapabilities } from "../core/runtime-provider-reconcile.js";

/**
 * Two CLI helpers, both fetch-driven against the hub:
 *   - `reconcileLocalRuntimeProviders` rewrites local `agent.yaml::runtime`
 *     when it disagrees with `agents.runtime_provider` (hub authoritative).
 *   - `uploadClientCapabilities` PATCHes the per-machine probe results to
 *     `clients.metadata.capabilities`.
 *
 * Both are best-effort on the CLI startup path, so these tests pin the
 * happy/unhappy contracts and verify the YAML round-trip is non-lossy
 * (other keys preserved). Without coverage, a regression that drops
 * `agentId` or rewrites every yaml unconditionally would only surface at
 * production startup.
 */
describe("reconcileLocalRuntimeProviders", () => {
  let agentsDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    agentsDir = mkdtempSync(join(tmpdir(), "ft-hub-reconcile-"));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    rmSync(agentsDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  function seedAgentDir(name: string, yamlContent: Record<string, unknown>): string {
    const dir = join(agentsDir, name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "agent.yaml");
    writeFileSync(
      path,
      Object.entries(yamlContent)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join("\n"),
    );
    return path;
  }

  it("rewrites agent.yaml when hub says a different runtime_provider", async () => {
    const yamlPath = seedAgentDir("alpha", { agentId: "agent-1", runtime: "claude-code", workspaceLabel: "alpha-ws" });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ agentId: "agent-1", clientId: "cli-1", runtimeProvider: "codex" }]), {
        status: 200,
      }),
    );

    await reconcileLocalRuntimeProviders({
      serverUrl: "http://hub.test",
      accessToken: "tok",
      agentsDir,
    });

    const after = parseYaml(readFileSync(yamlPath, "utf-8")) as Record<string, unknown>;
    expect(after.runtime).toBe("codex");
    // Sibling keys must survive the rewrite.
    expect(after.agentId).toBe("agent-1");
    expect(after.workspaceLabel).toBe("alpha-ws");
  });

  it("leaves agent.yaml untouched when runtime already matches hub", async () => {
    const yamlPath = seedAgentDir("beta", { agentId: "agent-2", runtime: "codex" });
    const before = readFileSync(yamlPath, "utf-8");
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ agentId: "agent-2", clientId: "cli-1", runtimeProvider: "codex" }]), {
        status: 200,
      }),
    );

    await reconcileLocalRuntimeProviders({
      serverUrl: "http://hub.test",
      accessToken: "tok",
      agentsDir,
    });

    expect(readFileSync(yamlPath, "utf-8")).toBe(before);
  });

  it("ignores local agents that aren't pinned to this user (hub returns no entry)", async () => {
    const yamlPath = seedAgentDir("gamma", { agentId: "stale-agent", runtime: "claude-code" });
    const before = readFileSync(yamlPath, "utf-8");
    fetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    await reconcileLocalRuntimeProviders({
      serverUrl: "http://hub.test",
      accessToken: "tok",
      agentsDir,
    });

    expect(readFileSync(yamlPath, "utf-8")).toBe(before);
  });

  it("throws when hub returns a non-OK status (caller wraps best-effort)", async () => {
    fetchMock.mockResolvedValue(new Response("server down", { status: 500 }));
    await expect(
      reconcileLocalRuntimeProviders({
        serverUrl: "http://hub.test",
        accessToken: "tok",
        agentsDir,
      }),
    ).rejects.toThrow(/500/);
  });

  it("warns + skips an agent with malformed yaml without aborting the whole pass", async () => {
    const goodPath = seedAgentDir("good", { agentId: "agent-good", runtime: "claude-code" });
    const badDir = join(agentsDir, "broken");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "agent.yaml"), ":\n\t-broken: yaml: [");

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ agentId: "agent-good", clientId: "cli-1", runtimeProvider: "codex" }]), {
        status: 200,
      }),
    );

    const logs: Array<[string, string]> = [];
    await reconcileLocalRuntimeProviders({
      serverUrl: "http://hub.test",
      accessToken: "tok",
      agentsDir,
      log: (level, msg) => logs.push([level, msg]),
    });

    // `good` still got reconciled despite the sibling parse failure.
    const after = parseYaml(readFileSync(goodPath, "utf-8")) as { runtime?: string };
    expect(after.runtime).toBe("codex");
    expect(logs.some(([level, msg]) => level === "warn" && /broken/.test(msg))).toBe(true);
  });
});

describe("uploadClientCapabilities", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes /clients/:id/capabilities with the snapshot", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await uploadClientCapabilities({
      serverUrl: "http://hub.test",
      accessToken: "tok-xyz",
      clientId: "cli-1",
      capabilities: {
        "claude-code": {
          state: "ok",
          available: true,
          authenticated: true,
          sdkVersion: "0.2.84",
          authMethod: "oauth",
          detectedAt: "2026-04-29T00:00:00Z",
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("fetch was not called");
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe("http://hub.test/api/v1/clients/cli-1/capabilities");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-xyz");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body.capabilities["claude-code"].state).toBe("ok");
  });

  it("URL-encodes the clientId so paths with `/` or unicode survive", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await uploadClientCapabilities({
      serverUrl: "http://hub.test",
      accessToken: "tok",
      clientId: "weird/client id",
      capabilities: {},
    });
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("fetch was not called");
    const url = call[0] as string;
    expect(url).toBe("http://hub.test/api/v1/clients/weird%2Fclient%20id/capabilities");
  });

  it("throws on non-OK status so the caller can log + continue", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 403 }));
    await expect(
      uploadClientCapabilities({
        serverUrl: "http://hub.test",
        accessToken: "tok",
        clientId: "cli-1",
        capabilities: {},
      }),
    ).rejects.toThrow(/403/);
  });
});
