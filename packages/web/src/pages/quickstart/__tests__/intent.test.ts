// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearCampaignIntent,
  deriveRepoAgentDisplayName,
  normalizeGitHubRepoUrl,
  readCampaignHandoff,
  readCampaignIntent,
  writeCampaignIntent,
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

describe("campaign quickstart intent storage", () => {
  it("stores repo intent only in sessionStorage", () => {
    const repo = normalizeGitHubRepoUrl("https://github.com/acme/backend");
    const intent = repo ? { campaign: "production_scan" as const, ...repo } : null;
    if (!intent) throw new Error("expected valid intent");

    writeCampaignIntent(intent);

    expect(readCampaignIntent()).toEqual(intent);
    expect(window.localStorage?.getItem?.("first-tree:quickstart:intent") ?? null).toBeNull();
  });

  it("clears invalid stored intent", () => {
    window.sessionStorage.setItem("first-tree:quickstart:intent", "{bad");

    expect(readCampaignIntent()).toBeNull();
    expect(window.sessionStorage.getItem("first-tree:quickstart:intent")).toBeNull();
  });

  it("can clear a valid intent after kickoff starts", () => {
    const repo = normalizeGitHubRepoUrl("https://github.com/acme/backend");
    const intent = repo ? { campaign: "production_scan" as const, ...repo } : null;
    if (!intent) throw new Error("expected valid intent");

    writeCampaignIntent(intent);
    clearCampaignIntent();

    expect(readCampaignIntent()).toBeNull();
  });

  it("reads the website handoff from legacy intent or campaign params", () => {
    expect(
      readCampaignHandoff({
        search: "?intent=production-scan&repo=https%3A%2F%2Fgithub.com%2Facme%2Fbackend",
        hash: "",
      }),
    ).toEqual({
      campaign: "production_scan",
      owner: "acme",
      repo: "backend",
      repoSlug: "acme/backend",
      url: "https://github.com/acme/backend",
    });
    expect(
      readCampaignHandoff({
        search: "",
        hash: "#campaign=production-scan&repo=https%3A%2F%2Fgithub.com%2Facme%2Fbackend",
      }),
    ).toEqual({
      campaign: "production_scan",
      owner: "acme",
      repo: "backend",
      repoSlug: "acme/backend",
      url: "https://github.com/acme/backend",
    });
  });
});

describe("deriveRepoAgentDisplayName", () => {
  it("derives a compact agent display name from the repo name", () => {
    expect(deriveRepoAgentDisplayName("backend")).toBe("Backend scan agent");
    expect(deriveRepoAgentDisplayName("first-tree-web")).toBe("First Tree Web scan agent");
  });
});
