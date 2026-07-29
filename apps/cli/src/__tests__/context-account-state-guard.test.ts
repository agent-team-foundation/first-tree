import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { switchLocalClientForLogin } from "../core/client-switch.js";
import { withContextIntegrationLock } from "../core/context-integration/context-binding-store.js";
import { recoverContextIntegrationOperation } from "../core/context-integration/operation.js";
import type { ContextIntegrationProviderDriver } from "../core/context-integration/provider-driver.js";

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
    writeFileSync(join(home, "state", "context", "operation-journal.json"), "{}");

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
    ).rejects.toThrow("Context Plugin/binding operation is active or incomplete");
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
