import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { switchLocalClientForLogin } from "../core/client-switch.js";
import { withContextIntegrationLock } from "../core/context-integration/context-binding-store.js";
import { recoverContextIntegrationOperation } from "../core/context-integration/operation.js";
import type { ContextIntegrationProviderDriver } from "../core/context-integration/provider-driver.js";
import { contextRepairCommand } from "../core/context-integration/repair-guidance.js";

const originalFirstTreeHome = process.env.FIRST_TREE_HOME;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
});

function setupHome(): string {
  const home = mkdtempSync(join(tmpdir(), "first-tree-account-state-"));
  roots.push(home);
  process.env.FIRST_TREE_HOME = home;
  mkdirSync(join(home, "state", "context"), { recursive: true });
  return home;
}

describe("Context/client-switch account-state interlock", () => {
  it("blocks a client switch while a durable Context operation exists", async () => {
    const home = setupHome();
    writeFileSync(
      join(home, "state", "context", "operation-journal.json"),
      JSON.stringify({
        schemaVersion: 1,
        operationId: "12345678-1234-4123-8123-123456789abc",
        accountClientId: "client_1234abcd",
        provider: "codex",
        operation: "disable",
        phase: "binding_changed",
        previousBindings: [
          {
            provider: "codex",
            project: { kind: "path", root: "/work/legacy" },
            organizationId: "org-legacy",
          },
        ],
        previousInstallManifest: null,
        providerInstalled: false,
        providerEnabled: false,
        marketplaceSourceExisted: false,
        recoveryMarketplaceRoot: null,
        startedAt: "2026-07-30T00:00:00.000Z",
      }),
    );

    await expect(
      switchLocalClientForLogin({
        existingCredentials: {
          accessToken: "old",
          refreshToken: "old",
          serverUrl: "https://first-tree.example",
        },
        previousOwnerSub: "old-user",
        targetTokens: {
          accessToken: "new",
          refreshToken: "new",
          serverUrl: "https://first-tree.example",
        },
        targetOwnerSub: "new-user",
      }),
    ).rejects.toThrow(contextRepairCommand("codex"));
    expect(existsSync(join(home, "state", "client-switch-journal.json"))).toBe(false);
  });

  it("preserves and reports a corrupt Context journal instead of suggesting a provider placeholder", async () => {
    const home = setupHome();
    const journal = join(home, "state", "context", "operation-journal.json");
    writeFileSync(journal, '{"provider":"codex"}');

    await expect(
      switchLocalClientForLogin({
        existingCredentials: {
          accessToken: "old",
          refreshToken: "old",
          serverUrl: "https://first-tree.example",
        },
        previousOwnerSub: "old-user",
        targetTokens: {
          accessToken: "new",
          refreshToken: "new",
          serverUrl: "https://first-tree.example",
        },
        targetOwnerSub: "new-user",
      }),
    ).rejects.toThrow(`journal at ${journal} is unreadable or invalid`);
    expect(existsSync(journal)).toBe(true);
  });

  it("tells account switching to wait for a live Context lock without suggesting repair", async () => {
    const home = setupHome();
    writeFileSync(join(home, "state", "context", "install.lock"), `${process.pid}\n`);

    await expect(
      switchLocalClientForLogin({
        existingCredentials: {
          accessToken: "old",
          refreshToken: "old",
          serverUrl: "https://first-tree.example",
        },
        previousOwnerSub: "old-user",
        targetTokens: {
          accessToken: "new",
          refreshToken: "new",
          serverUrl: "https://first-tree.example",
        },
        targetOwnerSub: "new-user",
      }),
    ).rejects.toThrow("Wait for it to finish");
  });

  it("blocks account switching while a BYO write worktree or recovery receipt is active", async () => {
    const home = setupHome();
    mkdirSync(join(home, "data", "byo", "org-acme", "worktrees", "write-1"), { recursive: true });
    mkdirSync(join(home, "state", "context", "byo", "org-acme", "writes"), { recursive: true });
    writeFileSync(join(home, "state", "context", "byo", "org-acme", "writes", "write-1.json"), "{}\n");

    await expect(
      switchLocalClientForLogin({
        existingCredentials: {
          accessToken: "old",
          refreshToken: "old",
          serverUrl: "https://first-tree.example",
        },
        previousOwnerSub: "old-user",
        targetTokens: {
          accessToken: "new",
          refreshToken: "new",
          serverUrl: "https://first-tree.example",
        },
        targetOwnerSub: "new-user",
      }),
    ).rejects.toThrow("BYO Context Tree write is active");
    expect(existsSync(join(home, "state", "client-switch-journal.json"))).toBe(false);
  });

  it("blocks every Context mutation/recovery while a client-switch journal exists", () => {
    const home = setupHome();
    writeFileSync(join(home, "state", "client-switch-journal.json"), "{}");
    const driver: ContextIntegrationProviderDriver = {
      provider: "codex",
      executable: "codex",
      minimumVersion: "0.144.0",
      probe: () => {
        throw new Error("must not probe");
      },
      inspectHook: async () => {
        throw new Error("must not inspect");
      },
      validateMarketplace: () => undefined,
      install: () => {
        throw new Error("must not install");
      },
      uninstall: () => {
        throw new Error("must not uninstall");
      },
    };

    expect(() => withContextIntegrationLock(() => undefined)).toThrow("client account switch is active or incomplete");
    expect(() => recoverContextIntegrationOperation(driver)).toThrow("client account switch is active or incomplete");
  });

  it("serializes live client and Context mutations through the shared account lock", () => {
    const home = setupHome();
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "state", "account-state.lock"), `${process.pid}\n`);

    expect(() => withContextIntegrationLock(() => undefined)).toThrow(
      "Another First Tree account or Context state change is already running",
    );
  });
});
