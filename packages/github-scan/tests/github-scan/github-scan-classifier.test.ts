/**
 * Exhaustive coverage for `classifyGitHubScanStatus`, mirroring the state
 * machine defined in the status state-machine spec (historical migration doc, now removed; see git history).
 *
 * Every named transition from spec §1 and every precedence rule from
 * spec §2 gets its own assertion so the intent is visible.
 */
import { describe, expect, it } from "vitest";

import { classifyGitHubScanStatus } from "../../src/github-scan/engine/runtime/classifier.js";

describe("classifier — precedence rules (spec §2)", () => {
  it("rule 1: github-scan:done wins over everything", () => {
    // github-scan:done > OPEN state
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:done"], ghState: "OPEN" }),
    ).toBe("done");
    // github-scan:done beats github-scan:human + github-scan:wip (fetcher.rs:816-822)
    expect(
      classifyGitHubScanStatus({
        labels: ["github-scan:done", "github-scan:human", "github-scan:wip"],
        ghState: "OPEN",
      }),
    ).toBe("done");
    // github-scan:done wins over MERGED/CLOSED too (idempotent).
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:done"], ghState: "MERGED" }),
    ).toBe("done");
  });

  it("rule 2: MERGED/CLOSED derives done absent github-scan:done", () => {
    expect(
      classifyGitHubScanStatus({ labels: [], ghState: "MERGED" }),
    ).toBe("done");
    expect(
      classifyGitHubScanStatus({ labels: [], ghState: "CLOSED" }),
    ).toBe("done");
  });

  it("rule 2: MERGED/CLOSED wins over github-scan:human and github-scan:wip", () => {
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:human"], ghState: "MERGED" }),
    ).toBe("done");
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:wip"], ghState: "CLOSED" }),
    ).toBe("done");
  });

  it("rule 3: github-scan:human wins on OPEN", () => {
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:human"], ghState: "OPEN" }),
    ).toBe("human");
  });

  it("rule 3: github-scan:human wins over github-scan:wip on OPEN", () => {
    expect(
      classifyGitHubScanStatus({
        labels: ["github-scan:human", "github-scan:wip"],
        ghState: "OPEN",
      }),
    ).toBe("human");
  });

  it("rule 4: github-scan:wip on OPEN derives wip", () => {
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:wip"], ghState: "OPEN" }),
    ).toBe("wip");
  });

  it("rule 5: no github-scan:* labels on OPEN → new", () => {
    expect(classifyGitHubScanStatus({ labels: [], ghState: "OPEN" })).toBe("new");
  });

  it("rule 5: unrelated labels on OPEN → new", () => {
    expect(
      classifyGitHubScanStatus({
        labels: ["bug", "wontfix", "area:docs"],
        ghState: "OPEN",
      }),
    ).toBe("new");
  });

  it("rule 5: github-scan:new label alone does NOT override (§2 subtleties)", () => {
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:new"], ghState: "OPEN" }),
    ).toBe("new");
  });
});

describe("classifier — null / undefined ghState (Discussion et al.)", () => {
  it("null ghState + no github-scan labels → new", () => {
    expect(classifyGitHubScanStatus({ labels: [], ghState: null })).toBe("new");
    expect(classifyGitHubScanStatus({ labels: [], ghState: undefined })).toBe("new");
  });
  it("null ghState + github-scan:wip → wip (labels still drive derivation)", () => {
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:wip"], ghState: null }),
    ).toBe("wip");
  });
  it("null ghState + github-scan:human → human", () => {
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:human"], ghState: null }),
    ).toBe("human");
  });
  it("null ghState + github-scan:done → done", () => {
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:done"], ghState: null }),
    ).toBe("done");
  });
});

describe("classifier — observable state-machine transitions (spec §1)", () => {
  // Each transition is expressed as a before/after pair: we classify the
  // "after" state with its label + gh_state snapshot, because the classifier
  // itself is stateless. The comment names the §1 transition.

  it("[*] → new: first-seen notification", () => {
    expect(classifyGitHubScanStatus({ labels: [], ghState: "OPEN" })).toBe("new");
  });

  it("new → wip: github-scan:wip label added", () => {
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:wip"], ghState: "OPEN" }),
    ).toBe("wip");
  });

  it("new → human: github-scan:human label added", () => {
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:human"], ghState: "OPEN" }),
    ).toBe("human");
  });

  it("new → done (via label): github-scan:done added, still OPEN", () => {
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:done"], ghState: "OPEN" }),
    ).toBe("done");
  });

  it("new → done (via gh_state): state flips to MERGED/CLOSED", () => {
    expect(classifyGitHubScanStatus({ labels: [], ghState: "MERGED" })).toBe("done");
    expect(classifyGitHubScanStatus({ labels: [], ghState: "CLOSED" })).toBe("done");
  });

  it("wip → human: label swap", () => {
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:human"], ghState: "OPEN" }),
    ).toBe("human");
  });

  it("wip → done (via label swap)", () => {
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:done"], ghState: "OPEN" }),
    ).toBe("done");
  });

  it("wip → done (via gh_state MERGED/CLOSED)", () => {
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:wip"], ghState: "MERGED" }),
    ).toBe("done");
  });

  it("wip → new: all github-scan:* labels removed while OPEN", () => {
    expect(classifyGitHubScanStatus({ labels: [], ghState: "OPEN" })).toBe("new");
  });

  it("human → wip: label swap", () => {
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:wip"], ghState: "OPEN" }),
    ).toBe("wip");
  });

  it("human → done (label swap)", () => {
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:done"], ghState: "OPEN" }),
    ).toBe("done");
  });

  it("human → done (gh_state MERGED/CLOSED)", () => {
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:human"], ghState: "CLOSED" }),
    ).toBe("done");
  });

  it("human → new: all labels removed, still OPEN", () => {
    expect(classifyGitHubScanStatus({ labels: [], ghState: "OPEN" })).toBe("new");
  });

  it("done → new: github-scan:done removed AND gh_state OPEN (reopen)", () => {
    expect(classifyGitHubScanStatus({ labels: [], ghState: "OPEN" })).toBe("new");
  });

  it("done → wip: reopen with github-scan:wip", () => {
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:wip"], ghState: "OPEN" }),
    ).toBe("wip");
  });

  it("done → human: reopen with github-scan:human", () => {
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:human"], ghState: "OPEN" }),
    ).toBe("human");
  });
});

describe("classifier — edge cases (spec §9)", () => {
  it("PR reopened after done: labels still drive, stays done (spec §9)", () => {
    // gh_state OPEN but github-scan:done label still present → done wins.
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:done"], ghState: "OPEN" }),
    ).toBe("done");
  });

  it("PR merged while github-scan:human on it → done (not human)", () => {
    expect(
      classifyGitHubScanStatus({ labels: ["github-scan:human"], ghState: "MERGED" }),
    ).toBe("done");
  });
});
