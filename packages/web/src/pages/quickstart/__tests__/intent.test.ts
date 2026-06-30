// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import {
  type CampaignIntent,
  clearCampaignIntent,
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

const REPO_ENC = encodeURIComponent("https://github.com/acme/backend");
const INTENT: CampaignIntent = {
  campaign: "production-scan",
  owner: "acme",
  repo: "backend",
  repoSlug: "acme/backend",
  url: "https://github.com/acme/backend",
};

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

describe("readCampaignHandoff", () => {
  it("reads campaign + repo from the query string", () => {
    expect(readCampaignHandoff({ search: `?campaign=production-scan&repo=${REPO_ENC}`, hash: "" })).toEqual(INTENT);
  });

  it("supports the legacy intent= alias and the agent-readiness campaign", () => {
    expect(readCampaignHandoff({ search: `?intent=production-scan&repo=${REPO_ENC}`, hash: "" })?.campaign).toBe(
      "production-scan",
    );
    expect(readCampaignHandoff({ search: `?campaign=agent-readiness&repo=${REPO_ENC}`, hash: "" })?.campaign).toBe(
      "agent-readiness",
    );
  });

  it("reads from the hash fragment too (OAuth round-trips can land params there)", () => {
    expect(readCampaignHandoff({ search: "", hash: `#campaign=production-scan&repo=${REPO_ENC}` })?.repoSlug).toBe(
      "acme/backend",
    );
  });

  it("returns null for an unknown campaign or a missing/invalid repo", () => {
    expect(readCampaignHandoff({ search: `?campaign=nope&repo=${REPO_ENC}`, hash: "" })).toBeNull();
    expect(readCampaignHandoff({ search: "?campaign=production-scan", hash: "" })).toBeNull();
    expect(
      readCampaignHandoff({ search: "?campaign=production-scan&repo=https://gitlab.com/x/y", hash: "" }),
    ).toBeNull();
  });
});

describe("campaign intent sessionStorage", () => {
  it("round-trips a valid intent in sessionStorage only (never localStorage)", () => {
    writeCampaignIntent(INTENT);
    expect(readCampaignIntent()).toEqual(INTENT);
    expect(window.localStorage?.getItem?.("first-tree:quickstart:intent") ?? null).toBeNull();
  });

  it("clears an invalid stored intent", () => {
    window.sessionStorage.setItem("first-tree:quickstart:intent", "{bad");
    expect(readCampaignIntent()).toBeNull();
    expect(window.sessionStorage.getItem("first-tree:quickstart:intent")).toBeNull();
  });

  it("rejects a stored intent whose campaign is no longer known", () => {
    window.sessionStorage.setItem(
      "first-tree:quickstart:intent",
      JSON.stringify({ ...INTENT, campaign: "retired-campaign" }),
    );
    expect(readCampaignIntent()).toBeNull();
  });

  it("can clear a valid intent once start chat begins", () => {
    writeCampaignIntent(INTENT);
    clearCampaignIntent();
    expect(readCampaignIntent()).toBeNull();
  });
});
