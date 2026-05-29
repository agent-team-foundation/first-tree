// @vitest-environment happy-dom

import type { AgentRuntimeConfig } from "@first-tree/shared";
import { ENV_REDACTED_PLACEHOLDER } from "@first-tree/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UseConfigDraftResult } from "../use-config-draft.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;
let latest: UseConfigDraftResult | null = null;

const BASE_CONFIG: AgentRuntimeConfig = {
  agentId: "agent-1",
  version: 1,
  payload: {
    kind: "claude-code",
    prompt: { append: "Be concise." },
    model: "sonnet",
    reasoningEffort: "medium",
    mcpServers: [{ name: "fs", transport: "stdio", command: "npx", args: ["server"] }],
    env: [
      { key: "OPENAI_API_KEY", value: ENV_REDACTED_PLACEHOLDER, sensitive: true },
      { key: "MODE", value: "dev", sensitive: false },
    ],
    gitRepos: [{ url: "https://github.com/acme/web.git", localPath: "web", ref: "main" }],
  },
  updatedAt: "2026-05-28T00:00:00.000Z",
  updatedBy: "member-1",
};

async function renderHook(config: AgentRuntimeConfig | undefined = BASE_CONFIG): Promise<void> {
  const { useConfigDraft } = await import("../use-config-draft.js");
  function Probe({ cfg }: { cfg: AgentRuntimeConfig | undefined }) {
    latest = useConfigDraft(cfg);
    return <div>{latest.summary.anyDirty ? "dirty" : "clean"}</div>;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Probe cfg={config} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  latest = null;
  container = null;
  root = null;
  document.body.innerHTML = "";
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  document.body.innerHTML = "";
});

describe("useConfigDraft", () => {
  it("creates clean drafts and builds scalar patches", async () => {
    await renderHook();

    expect(latest?.summary.anyDirty).toBe(false);
    act(() => {
      latest?.setPromptAppend("Explain tradeoffs.");
      latest?.setModel("opus");
      latest?.setReasoningEffort("high");
    });

    expect(latest?.summary.dirtySections).toEqual(["prompt", "model", "effort"]);
    expect(latest?.buildPayloadPatch()).toMatchObject({
      prompt: { append: "Explain tradeoffs." },
      model: "opus",
      reasoningEffort: "high",
    });

    act(() => {
      latest?.revertPrompt();
      latest?.revertModel();
      latest?.revertReasoningEffort();
    });
    expect(latest?.summary.anyDirty).toBe(false);
  });

  it("tracks list add/update/delete/undo and redacts sensitive env patches", async () => {
    await renderHook();

    act(() => {
      latest?.updateMcp("mcp-1", { name: "docs", transport: "http", url: "https://docs.example.com/mcp" });
      latest?.addEnv({ key: "NEW_FLAG", value: "1", sensitive: false });
      latest?.deleteEnv("env-1");
      latest?.addGit({ url: "git@github.com:acme/api.git", localPath: "api" });
    });

    expect(latest?.summary.counts).toMatchObject({ mcp: 1, env: 2, git: 1 });
    expect(latest?.buildPayloadPatch()).toMatchObject({
      mcpServers: [{ name: "docs", transport: "http", url: "https://docs.example.com/mcp" }],
      env: [
        { key: "MODE", value: "dev", sensitive: false },
        { key: "NEW_FLAG", value: "1", sensitive: false },
      ],
      gitRepos: [
        { url: "https://github.com/acme/web.git", localPath: "web", ref: "main" },
        { url: "git@github.com:acme/api.git", localPath: "api" },
      ],
    });

    act(() => {
      latest?.undoDeleteEnv("env-1");
      latest?.updateEnv("env-1", { key: "OPENAI_API_KEY", value: ENV_REDACTED_PLACEHOLDER, sensitive: true });
    });
    expect(latest?.buildPayloadPatch().env).toContainEqual({
      key: "OPENAI_API_KEY",
      value: ENV_REDACTED_PLACEHOLDER,
      sensitive: true,
    });
  });

  it("drops newly added list rows, resets all, and resets to a supplied config", async () => {
    await renderHook();

    act(() => {
      latest?.addMcp({ name: "temp", transport: "stdio", command: "node" });
    });
    const addedKey = latest?.draft.mcp.find((item) => item.baseline === null)?.key;
    expect(addedKey).toBeTruthy();

    act(() => {
      if (addedKey) latest?.deleteMcp(addedKey);
    });
    expect(latest?.draft.mcp.some((item) => item.baseline === null)).toBe(false);

    act(() => {
      latest?.resetAll();
    });
    expect(latest?.summary.anyDirty).toBe(false);
    expect(latest?.draft.mcp).toHaveLength(1);

    const nextConfig: AgentRuntimeConfig = {
      ...BASE_CONFIG,
      version: 2,
      payload: { ...BASE_CONFIG.payload, model: "gpt-5.1" },
    };
    act(() => {
      latest?.resetToConfig(nextConfig);
    });
    expect(latest?.draft.model).toBe("gpt-5.1");
    expect(latest?.buildPayloadPatch()).toEqual({});
  });

  it("returns an empty patch before config loads", async () => {
    await renderHook(undefined);
    expect(latest?.buildPayloadPatch()).toEqual({});
  });
});
