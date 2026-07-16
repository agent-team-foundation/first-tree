// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import {
  type CampaignIntent,
  clearCampaignIntent,
  normalizeGitHubRepoUrl,
  normalizeReportKey,
  readCampaignActionHandoff,
  readCampaignHandoff,
  readCampaignIntent,
  readScanFixHandoff,
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
const ATTEMPT_ID = "018f5f17-7bb0-7d6d-8d86-91c901d5f2bf";
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

  it("keeps valid anonymous attempt attribution and ignores incomplete or invalid values", () => {
    expect(
      readCampaignHandoff({
        search: `?campaign=production-scan&repo=${REPO_ENC}&attempt=${ATTEMPT_ID}&variant=control`,
        hash: "",
      }),
    ).toEqual({ ...INTENT, attribution: { attemptId: ATTEMPT_ID, variant: "control" } });
    expect(
      readCampaignHandoff({
        search: `?campaign=production-scan&repo=${REPO_ENC}&attempt=not-a-uuid&variant=control`,
        hash: "",
      }),
    ).toEqual(INTENT);
    expect(
      readCampaignHandoff({
        search: `?campaign=production-scan&repo=${REPO_ENC}&attempt=${ATTEMPT_ID}`,
        hash: "",
      }),
    ).toEqual(INTENT);
  });

  it("supports the legacy intent= alias for production scan", () => {
    expect(readCampaignHandoff({ search: `?intent=production-scan&repo=${REPO_ENC}`, hash: "" })?.campaign).toBe(
      "production-scan",
    );
  });

  it("reads from the hash fragment too (OAuth round-trips can land params there)", () => {
    expect(readCampaignHandoff({ search: "", hash: `#campaign=production-scan&repo=${REPO_ENC}` })?.repoSlug).toBe(
      "acme/backend",
    );
  });

  it("returns null for an unknown campaign or a missing/invalid repo", () => {
    expect(readCampaignHandoff({ search: `?campaign=nope&repo=${REPO_ENC}`, hash: "" })).toBeNull();
    expect(readCampaignHandoff({ search: `?campaign=agent-readiness&repo=${REPO_ENC}`, hash: "" })).toBeNull();
    expect(readCampaignHandoff({ search: "?campaign=production-scan", hash: "" })).toBeNull();
    expect(
      readCampaignHandoff({ search: "?campaign=production-scan&repo=https://gitlab.com/x/y", hash: "" }),
    ).toBeNull();
  });
});

describe("campaign intent sessionStorage", () => {
  it("round-trips a valid intent in sessionStorage only (never localStorage)", () => {
    const attributed = { ...INTENT, attribution: { attemptId: ATTEMPT_ID, variant: "control" } };
    writeCampaignIntent(attributed);
    expect(readCampaignIntent()).toEqual(attributed);
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

  it("rejects a stored intent with malformed attribution", () => {
    window.sessionStorage.setItem(
      "first-tree:quickstart:intent",
      JSON.stringify({ ...INTENT, attribution: { attemptId: "bad", variant: "control" } }),
    );
    expect(readCampaignIntent()).toBeNull();
  });

  it("can clear a valid intent once start chat begins", () => {
    writeCampaignIntent(INTENT);
    clearCampaignIntent();
    expect(readCampaignIntent()).toBeNull();
  });
});

describe("readScanFixHandoff", () => {
  const loc = (search: string) => ({ search, hash: "" });

  it("parses a fix handoff with a report key", () => {
    const h = readScanFixHandoff(
      loc(
        "?campaign=production-scan&repo=https%3A%2F%2Fgithub.com%2Focto%2Fapp&action=fix&report=octo-app-20260707-ab12cd3",
      ),
    );
    expect(h).toEqual({
      campaign: "production-scan",
      owner: "octo",
      repo: "app",
      repoSlug: "octo/app",
      url: "https://github.com/octo/app",
      reportKey: "octo-app-20260707-ab12cd3",
    });
  });

  it("strips a .html/.json suffix off the report key", () => {
    const h = readScanFixHandoff(
      loc(
        "?campaign=production-scan&repo=https%3A%2F%2Fgithub.com%2Focto%2Fapp&action=fix&report=octo-app-20260707-ab12cd3.html",
      ),
    );
    expect(h?.reportKey).toBe("octo-app-20260707-ab12cd3");
  });

  it("degrades an invalid report key to null instead of rejecting the handoff", () => {
    for (const bad of ["../../etc", "a/b", "https://evil.example", "", "-leading-dash-ok?no"]) {
      const h = readScanFixHandoff(
        loc(
          `?campaign=production-scan&repo=https%3A%2F%2Fgithub.com%2Focto%2Fapp&action=fix&report=${encodeURIComponent(bad)}`,
        ),
      );
      expect(h).not.toBeNull();
      expect(h?.reportKey).toBeNull();
    }
  });

  it("returns null without action=fix, an unknown campaign, or a bad repo", () => {
    expect(readScanFixHandoff(loc("?campaign=production-scan&repo=https%3A%2F%2Fgithub.com%2Focto%2Fapp"))).toBeNull();
    expect(readScanFixHandoff(loc("?campaign=nope&repo=https%3A%2F%2Fgithub.com%2Focto%2Fapp&action=fix"))).toBeNull();
    expect(readScanFixHandoff(loc("?campaign=production-scan&repo=notaurl&action=fix"))).toBeNull();
  });

  it("parses from the hash after a login round-trip", () => {
    const h = readScanFixHandoff({
      search: "",
      hash: "#?campaign=production-scan&repo=https%3A%2F%2Fgithub.com%2Focto%2Fapp&action=fix&report=k1",
    });
    expect(h?.reportKey).toBe("k1");
  });
});

describe("readCampaignActionHandoff", () => {
  it("reads only the action configured for the known campaign", () => {
    expect(
      readCampaignActionHandoff({
        search: `?campaign=production-scan&repo=${REPO_ENC}&action=fix&report=report-1`,
        hash: "",
      }),
    ).toMatchObject({ campaign: "production-scan", action: "fix", repoSlug: "acme/backend" });
    expect(
      readCampaignActionHandoff({
        search: `?campaign=production-scan&repo=${REPO_ENC}&action=unknown`,
        hash: "",
      }),
    ).toBeNull();
  });
});

describe("readCampaignHandoff vs action=fix", () => {
  it("does NOT treat a fix link as a trial handoff", () => {
    expect(
      readCampaignHandoff({
        search: "?campaign=production-scan&repo=https%3A%2F%2Fgithub.com%2Focto%2Fapp&action=fix&report=k1",
        hash: "",
      }),
    ).toBeNull();
  });

  it("does NOT treat any unknown non-empty action as a trial handoff", () => {
    expect(
      readCampaignHandoff({
        search: `?campaign=production-scan&repo=${REPO_ENC}&action=unknown`,
        hash: "",
      }),
    ).toBeNull();
  });
});

describe("normalizeReportKey", () => {
  it("accepts the documented key shape", () => {
    expect(normalizeReportKey("octo-app-20260707-ab12cd3")).toBe("octo-app-20260707-ab12cd3");
    expect(normalizeReportKey("o.wner-re.po-20260707-ff00aa1.json")).toBe("o.wner-re.po-20260707-ff00aa1");
  });
  it("rejects path/URL shapes", () => {
    expect(normalizeReportKey("a/b")).toBeNull();
    expect(normalizeReportKey("..")).toBeNull();
    expect(normalizeReportKey(null)).toBeNull();
  });
});
