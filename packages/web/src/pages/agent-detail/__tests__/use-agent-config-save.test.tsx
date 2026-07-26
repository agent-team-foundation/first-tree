// @vitest-environment happy-dom

import type { AgentRuntimeConfig } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client.js";
import type { AgentConfigSaveController } from "../use-agent-config-save.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({ updateAgentConfig: vi.fn() }));
vi.mock("../../../api/agent-config.js", () => apiMocks);

let root: Root | null = null;
let queryClient: QueryClient;
let latest: AgentConfigSaveController | null = null;

const KEY = ["agent-config", "agent-1"];

function config(overrides: Partial<AgentRuntimeConfig["payload"]> = {}, version = 1): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
    version,
    // Cast the merge: spreading a Partial payload over the tagged-union base
    // widens the field types (same reason the hook casts its optimistic merge).
    payload: {
      kind: "claude-code",
      prompt: { append: "" },
      model: "sonnet",
      reasoningEffort: "medium",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
      ...overrides,
    } as AgentRuntimeConfig["payload"],
    updatedAt: "2026-06-18T00:00:00.000Z",
    updatedBy: "member-1",
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderHook(): Promise<void> {
  const { useAgentConfigSave } = await import("../use-agent-config-save.js");
  function Probe() {
    latest = useAgentConfigSave("agent-1");
    return <div>{latest.pending ? "saving" : "idle"}</div>;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  latest = null;
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(KEY, config());
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("useAgentConfigSave", () => {
  it("saves a partial patch with the cached version and writes the server response to cache", async () => {
    apiMocks.updateAgentConfig.mockResolvedValue(config({ model: "opus" }, 2));
    await renderHook();

    await act(async () => {
      latest?.save({ model: "opus" }, { field: "model" });
    });
    await flush();

    expect(apiMocks.updateAgentConfig).toHaveBeenCalledWith("agent-1", {
      expectedVersion: 1,
      payload: { model: "opus" },
    });
    const cached = queryClient.getQueryData<AgentRuntimeConfig>(KEY);
    expect(cached?.version).toBe(2);
    expect(cached?.payload.model).toBe("opus");
    expect(latest?.justSaved).toBe(true);
    expect(latest?.savedField).toBe("model");
  });

  it("optimistically reflects the change before the server responds", async () => {
    let resolveSave: ((c: AgentRuntimeConfig) => void) | null = null;
    apiMocks.updateAgentConfig.mockReturnValue(
      new Promise<AgentRuntimeConfig>((resolve) => {
        resolveSave = resolve;
      }),
    );
    await renderHook();

    await act(async () => {
      latest?.save({ model: "opus" }, { field: "model" });
    });
    await flush();

    // Server hasn't responded yet — cache already shows the optimistic value.
    expect(queryClient.getQueryData<AgentRuntimeConfig>(KEY)?.payload.model).toBe("opus");

    await act(async () => {
      resolveSave?.(config({ model: "opus" }, 2));
    });
    await flush();
    expect(queryClient.getQueryData<AgentRuntimeConfig>(KEY)?.version).toBe(2);
  });

  it("rolls back and flags conflict on 409", async () => {
    apiMocks.updateAgentConfig.mockRejectedValue(new ApiError(409, "version conflict"));
    await renderHook();

    await act(async () => {
      latest?.save({ model: "opus" }, { field: "model" });
    });
    await flush();

    const cached = queryClient.getQueryData<AgentRuntimeConfig>(KEY);
    expect(cached?.payload.model).toBe("sonnet");
    expect(cached?.version).toBe(1);
    expect(latest?.conflict).toBe(true);
    expect(latest?.saveError).toBeNull();
    expect(latest?.errorField).toBe("model");
  });

  it("surfaces a non-conflict error and rolls back", async () => {
    apiMocks.updateAgentConfig.mockRejectedValue(new ApiError(500, "boom"));
    await renderHook();

    await act(async () => {
      latest?.save({ reasoningEffort: "high" }, { field: "effort" });
    });
    await flush();

    const rolledBack = queryClient.getQueryData<AgentRuntimeConfig>(KEY)?.payload;
    expect(rolledBack && "reasoningEffort" in rolledBack ? rolledBack.reasoningEffort : undefined).toBe("medium");
    expect(latest?.conflict).toBe(false);
    expect(latest?.saveError).toContain("boom");
    expect(latest?.errorField).toBe("effort");
  });

  it("invokes the per-call onError and clears errorField on the next successful save", async () => {
    apiMocks.updateAgentConfig.mockRejectedValueOnce(new ApiError(500, "nope"));
    await renderHook();
    const onError = vi.fn();

    await act(async () => {
      latest?.save({ env: [] }, { field: "env", onError });
    });
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(latest?.errorField).toBe("env");

    apiMocks.updateAgentConfig.mockResolvedValueOnce(config({ model: "opus" }, 2));
    await act(async () => {
      latest?.save({ model: "opus" }, { field: "model" });
    });
    await flush();
    expect(latest?.errorField).toBeNull();
    expect(latest?.savedField).toBe("model");
  });
});
