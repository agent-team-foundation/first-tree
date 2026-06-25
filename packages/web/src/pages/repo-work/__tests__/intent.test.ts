// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearRepoWorkIntent,
  deriveRepoAgentDisplayName,
  normalizeGitHubRepoUrl,
  readRepoWorkIntent,
  writeRepoWorkIntent,
} from "../intent.js";

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

describe("normalizeGitHubRepoUrl", () => {
  it("normalizes browser and ssh GitHub repo URLs", () => {
    expect(normalizeGitHubRepoUrl("https://github.com/acme/backend")).toEqual({
      owner: "acme",
      repo: "backend",
      repoSlug: "acme/backend",
      url: "https://github.com/acme/backend",
    });
    expect(normalizeGitHubRepoUrl("https://github.com/acme/backend.git")).toEqual({
      owner: "acme",
      repo: "backend",
      repoSlug: "acme/backend",
      url: "https://github.com/acme/backend",
    });
    expect(normalizeGitHubRepoUrl("git@github.com:acme/backend.git")).toEqual({
      owner: "acme",
      repo: "backend",
      repoSlug: "acme/backend",
      url: "https://github.com/acme/backend",
    });
  });

  it("rejects non-GitHub or incomplete URLs", () => {
    expect(normalizeGitHubRepoUrl("https://gitlab.com/acme/backend")).toBeNull();
    expect(normalizeGitHubRepoUrl("https://github.com/acme")).toBeNull();
    expect(normalizeGitHubRepoUrl("not a url")).toBeNull();
  });
});

describe("repo work intent storage", () => {
  it("stores repo intent only in sessionStorage", () => {
    const intent = normalizeGitHubRepoUrl("https://github.com/acme/backend");
    if (!intent) throw new Error("expected valid intent");

    writeRepoWorkIntent(intent);

    expect(readRepoWorkIntent()).toEqual(intent);
    expect(window.localStorage?.getItem?.("first-tree:repo-work:intent") ?? null).toBeNull();
  });

  it("clears invalid stored intent", () => {
    window.sessionStorage.setItem("first-tree:repo-work:intent", "{bad");

    expect(readRepoWorkIntent()).toBeNull();
    expect(window.sessionStorage.getItem("first-tree:repo-work:intent")).toBeNull();
  });

  it("can clear a valid intent after kickoff starts", () => {
    const intent = normalizeGitHubRepoUrl("https://github.com/acme/backend");
    if (!intent) throw new Error("expected valid intent");

    writeRepoWorkIntent(intent);
    clearRepoWorkIntent();

    expect(readRepoWorkIntent()).toBeNull();
  });
});

describe("deriveRepoAgentDisplayName", () => {
  it("derives a compact agent display name from the repo name", () => {
    expect(deriveRepoAgentDisplayName("backend")).toBe("Backend agent");
    expect(deriveRepoAgentDisplayName("first-tree-web")).toBe("First Tree Web agent");
  });
});
