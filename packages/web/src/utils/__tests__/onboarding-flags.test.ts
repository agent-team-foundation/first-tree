import { beforeEach, describe, expect, it, vi } from "vitest";

function createSessionStorage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    get length() {
      return entries.size;
    },
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
    removeItem: (key: string) => entries.delete(key),
    setItem: (key: string, value: string) => entries.set(key, value),
    snapshot: () => Object.fromEntries(entries),
  };
}

describe("onboarding session flags", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("no-ops without a browser window", async () => {
    const flags = await import("../onboarding-flags.js");

    expect(flags.readOnboardingAgentUuid()).toBeNull();
    expect(() => flags.writeOnboardingAgentUuid("agent-1")).not.toThrow();
    expect(() => flags.markOnboardingResume("solo")).not.toThrow();
    expect(() => flags.clearOnboardingJoinPath()).not.toThrow();
    expect(() => flags.clearOnboardingSessionFlags()).not.toThrow();
  });

  it("writes, removes, and namespace-clears onboarding session storage", async () => {
    const storage = createSessionStorage({ "onboarding:old": "1", "other:key": "keep" });
    vi.stubGlobal("window", { sessionStorage: storage });
    const flags = await import("../onboarding-flags.js");

    flags.writeOnboardingAgentUuid("agent-1");
    expect(flags.readOnboardingAgentUuid()).toBe("agent-1");

    flags.writeOnboardingAgentUuid(null);
    expect(flags.readOnboardingAgentUuid()).toBeNull();

    flags.markOnboardingResume("invite");
    expect(storage.snapshot()).toMatchObject({ "onboarding:joinPath": "invite" });

    flags.clearOnboardingJoinPath();
    expect(storage.snapshot()).not.toHaveProperty("onboarding:joinPath");

    flags.writeOnboardingAgentUuid("agent-2");
    flags.markOnboardingResume("solo");
    flags.clearOnboardingSessionFlags();
    expect(storage.snapshot()).toEqual({ "other:key": "keep" });
  });
});
