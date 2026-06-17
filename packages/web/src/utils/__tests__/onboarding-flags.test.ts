// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearOnboardingJoinPath,
  clearOnboardingSessionFlags,
  markOnboardingResume,
  readOnboardingAgentUuid,
  readOnboardingSelectedRepos,
  writeOnboardingAgentUuid,
  writeOnboardingSelectedRepos,
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
    expect(readOnboardingSelectedRepos("org-1")).toBeNull();
    expect(() => writeOnboardingSelectedRepos("org-1", ["x"])).not.toThrow();
  });
});

describe("onboarding selected-repos draft", () => {
  const WEB = "https://github.com/acme/web.git";
  const API = "git@github.com:acme/api.git";
  const URLS = [WEB, API];

  it("round-trips a per-org draft and distinguishes absent from empty", () => {
    // No draft yet → null (so connect-code knows to auto-select all granted).
    expect(readOnboardingSelectedRepos("org-1")).toBeNull();

    writeOnboardingSelectedRepos("org-1", URLS);
    expect(readOnboardingSelectedRepos("org-1")).toEqual(URLS);

    // A deliberate "deselect everything" is an empty array, NOT null — the
    // distinction the connect-code preselect gate depends on.
    writeOnboardingSelectedRepos("org-1", []);
    expect(readOnboardingSelectedRepos("org-1")).toEqual([]);

    // null clears the key back to "no draft".
    writeOnboardingSelectedRepos("org-1", null);
    expect(readOnboardingSelectedRepos("org-1")).toBeNull();
  });

  it("keeps drafts independent per org", () => {
    writeOnboardingSelectedRepos("org-1", [WEB]);
    writeOnboardingSelectedRepos("org-2", [API]);
    expect(readOnboardingSelectedRepos("org-1")).toEqual([WEB]);
    expect(readOnboardingSelectedRepos("org-2")).toEqual([API]);
  });

  it("is swept by clearOnboardingSessionFlags (onboarding:* namespace)", () => {
    writeOnboardingSelectedRepos("org-1", URLS);
    clearOnboardingSessionFlags();
    expect(readOnboardingSelectedRepos("org-1")).toBeNull();
  });

  it("returns null for malformed or non-string-array stored values", () => {
    sessionStorage.setItem("onboarding:selectedRepos:org-1", "not json");
    expect(readOnboardingSelectedRepos("org-1")).toBeNull();
    sessionStorage.setItem("onboarding:selectedRepos:org-1", JSON.stringify([1, 2]));
    expect(readOnboardingSelectedRepos("org-1")).toBeNull();
    sessionStorage.setItem("onboarding:selectedRepos:org-1", JSON.stringify({ url: "x" }));
    expect(readOnboardingSelectedRepos("org-1")).toBeNull();
  });

  it("ignores a missing org id", () => {
    expect(readOnboardingSelectedRepos("")).toBeNull();
    expect(() => writeOnboardingSelectedRepos("", URLS)).not.toThrow();
  });
});
