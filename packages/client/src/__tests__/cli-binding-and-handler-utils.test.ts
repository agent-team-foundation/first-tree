import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentContextTreeBinding } from "../runtime/bootstrap.js";
import { getCliBinding, resetCliBindingForTest, setCliBinding } from "../runtime/cli-binding.js";
import { noopDeliveryToken } from "../runtime/handler.js";
import type { FirstTreeHubSDK } from "../sdk.js";

describe("cli-binding", () => {
  afterEach(() => {
    setCliBinding({ binName: "first-tree", packageName: "first-tree" });
  });

  it("throws when binding is not initialised and can be reset for tests", () => {
    resetCliBindingForTest();
    expect(() => getCliBinding()).toThrow(/CLI binding not initialised/);
    setCliBinding({ binName: "first-tree-dev", packageName: null });
    expect(getCliBinding()).toEqual({ binName: "first-tree-dev", packageName: null });
  });
});

describe("noopDeliveryToken", () => {
  it("provides no-op delivery methods", async () => {
    const token = noopDeliveryToken();
    const messages = [{ id: "m1" }] as never;
    token.processingStarted(messages);
    token.retry(messages, "reason");
    await token.complete(messages, { status: "success" });
    await token.terminalRejected(messages, "r", { kind: "provider", detail: "x" } as never);
  });
});

describe("resolveAgentContextTreeBinding", () => {
  it("returns a workspace path binding when the server has a repo", async () => {
    const logs: string[] = [];
    const sdk = {
      getAgentContextTreeConfig: async () => ({ repo: "https://github.com/acme/tree.git", branch: "dev" }),
    } as unknown as FirstTreeHubSDK;
    await expect(resolveAgentContextTreeBinding(sdk, "/tmp/ws", (m) => logs.push(m))).resolves.toEqual({
      path: "/tmp/ws/context-tree",
      repoUrl: "https://github.com/acme/tree.git",
      branch: "dev",
    });
  });

  it("skips when repo is null and when the SDK throws", async () => {
    const logs: string[] = [];
    const empty = {
      getAgentContextTreeConfig: async () => ({ repo: null, branch: null }),
    } as unknown as FirstTreeHubSDK;
    await expect(resolveAgentContextTreeBinding(empty, "/tmp/ws", (m) => logs.push(m))).resolves.toBeNull();
    expect(logs.some((l) => l.includes("not configured"))).toBe(true);

    const failing = {
      getAgentContextTreeConfig: async () => {
        throw new Error("down");
      },
    } as unknown as FirstTreeHubSDK;
    await expect(resolveAgentContextTreeBinding(failing, "/tmp/ws", (m) => logs.push(m))).resolves.toBeNull();
    expect(logs.some((l) => l.includes("failed to fetch"))).toBe(true);

    const plainFail = {
      getAgentContextTreeConfig: async () => {
        throw "plain";
      },
    } as unknown as FirstTreeHubSDK;
    await expect(resolveAgentContextTreeBinding(plainFail, "/tmp/ws", () => {})).resolves.toBeNull();
  });

  it("defaults branch to main when server omits it", async () => {
    const sdk = {
      getAgentContextTreeConfig: async () => ({ repo: "https://github.com/acme/tree.git", branch: null }),
    } as unknown as FirstTreeHubSDK;
    await expect(resolveAgentContextTreeBinding(sdk, "/ws", () => {})).resolves.toMatchObject({
      branch: "main",
    });
  });
});

describe("install skills catch paths", () => {
  it("installFirstTreeIntegration and installCoreSkills swallow thrown installer errors", async () => {
    vi.resetModules();
    vi.doMock("../runtime/first-tree-skills/installer.js", () => ({
      installFirstTreeSkills: () => {
        throw new Error("install boom");
      },
      installCoreSkills: () => {
        throw "core boom";
      },
    }));
    const bootstrap = await import("../runtime/bootstrap.js");
    const logs: string[] = [];
    expect(
      bootstrap.installFirstTreeIntegration({
        workspacePath: "/tmp/x",
        log: (m) => logs.push(m),
      }),
    ).toBe(false);
    expect(
      bootstrap.installCoreSkills({
        workspacePath: "/tmp/x",
        log: (m) => logs.push(m),
      }),
    ).toBe(false);
    expect(logs.some((l) => l.includes("install boom") || l.includes("skipped"))).toBe(true);
    vi.doUnmock("../runtime/first-tree-skills/installer.js");
    vi.resetModules();
  });
});
