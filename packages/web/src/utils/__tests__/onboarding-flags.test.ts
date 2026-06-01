// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearOnboardingJoinPath,
  clearOnboardingSessionFlags,
  markOnboardingResume,
  readOnboardingAgentUuid,
  writeOnboardingAgentUuid,
} from "../onboarding-flags.js";

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

describe("onboarding session flags", () => {
  it("stores, clears, and bulk-removes onboarding session keys", () => {
    expect(readOnboardingAgentUuid()).toBeNull();

    writeOnboardingAgentUuid("agent-1");
    expect(readOnboardingAgentUuid()).toBe("agent-1");
    writeOnboardingAgentUuid(null);
    expect(readOnboardingAgentUuid()).toBeNull();

    markOnboardingResume("invite");
    expect(sessionStorage.getItem("onboarding:joinPath")).toBe("invite");
    markOnboardingResume("solo");
    expect(sessionStorage.getItem("onboarding:joinPath")).toBe("solo");
    clearOnboardingJoinPath();
    expect(sessionStorage.getItem("onboarding:joinPath")).toBeNull();

    writeOnboardingAgentUuid("agent-2");
    markOnboardingResume("invite");
    sessionStorage.setItem("other:key", "keep");
    clearOnboardingSessionFlags();

    expect(sessionStorage.getItem("onboarding:agentUuid")).toBeNull();
    expect(sessionStorage.getItem("onboarding:joinPath")).toBeNull();
    expect(sessionStorage.getItem("other:key")).toBe("keep");
  });

  it("noops without a browser window", () => {
    vi.stubGlobal("window", undefined);

    expect(readOnboardingAgentUuid()).toBeNull();
    expect(() => writeOnboardingAgentUuid("agent-1")).not.toThrow();
    expect(() => markOnboardingResume("solo")).not.toThrow();
    expect(() => clearOnboardingJoinPath()).not.toThrow();
    expect(() => clearOnboardingSessionFlags()).not.toThrow();
  });
});
