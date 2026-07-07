// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readScanFixHandoffFlag, writeScanFixHandoffFlag } from "../onboarding-flags.js";

function createStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

beforeEach(() => {
  const storage = createStorage();
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("scan-fix handoff flag", () => {
  afterEach(() => writeScanFixHandoffFlag(null));

  it("round-trips a handoff", () => {
    const h = { repoUrl: "https://github.com/octo/app", reportKey: "octo-app-20260707-ab12cd3" };
    writeScanFixHandoffFlag(h);
    expect(readScanFixHandoffFlag()).toEqual(h);
  });

  it("round-trips a null report key", () => {
    writeScanFixHandoffFlag({ repoUrl: "https://github.com/octo/app", reportKey: null });
    expect(readScanFixHandoffFlag()?.reportKey).toBeNull();
  });

  it("clears on write(null) and rejects malformed stored values", () => {
    writeScanFixHandoffFlag({ repoUrl: "https://github.com/octo/app", reportKey: null });
    writeScanFixHandoffFlag(null);
    expect(readScanFixHandoffFlag()).toBeNull();
    window.sessionStorage.setItem("onboarding:scanFixHandoff", JSON.stringify({ nope: 1 }));
    expect(readScanFixHandoffFlag()).toBeNull();
    expect(window.sessionStorage.getItem("onboarding:scanFixHandoff")).toBeNull();
  });
});
