/**
 * Exhaustive coverage for `classifyBreezeStatus`, mirroring the state
 * machine defined in `docs/migration/03-status-state-machine.md`.
 *
 * Every named transition from spec §1 and every precedence rule from
 * spec §2 gets its own assertion so the intent is visible.
 */
import { describe, expect, it } from "vitest";

import { classifyBreezeStatus } from "../src/products/breeze/engine/runtime/classifier.js";

describe("classifier — precedence rules (spec §2)", () => {
  it("rule 1: breeze:done wins over everything", () => {
    // breeze:done > OPEN state
    expect(
      classifyBreezeStatus({ labels: ["breeze:done"], ghState: "OPEN" }),
    ).toBe("done");
    // breeze:done beats breeze:human + breeze:wip (fetcher.rs:816-822)
    expect(
      classifyBreezeStatus({
        labels: ["breeze:done", "breeze:human", "breeze:wip"],
        ghState: "OPEN",
      }),
    ).toBe("done");
    // breeze:done wins over MERGED/CLOSED too (idempotent).
    expect(
      classifyBreezeStatus({ labels: ["breeze:done"], ghState: "MERGED" }),
    ).toBe("done");
  });

  it("rule 2: MERGED/CLOSED derives done absent breeze:done", () => {
    expect(
      classifyBreezeStatus({ labels: [], ghState: "MERGED" }),
    ).toBe("done");
    expect(
      classifyBreezeStatus({ labels: [], ghState: "CLOSED" }),
    ).toBe("done");
  });

  it("rule 2: MERGED/CLOSED wins over breeze:human and breeze:wip", () => {
    expect(
      classifyBreezeStatus({ labels: ["breeze:human"], ghState: "MERGED" }),
    ).toBe("done");
    expect(
      classifyBreezeStatus({ labels: ["breeze:wip"], ghState: "CLOSED" }),
    ).toBe("done");
  });

  it("rule 3: breeze:human wins on OPEN", () => {
    expect(
      classifyBreezeStatus({ labels: ["breeze:human"], ghState: "OPEN" }),
    ).toBe("human");
  });

  it("rule 3: breeze:human wins over breeze:wip on OPEN", () => {
    expect(
      classifyBreezeStatus({
        labels: ["breeze:human", "breeze:wip"],
        ghState: "OPEN",
      }),
    ).toBe("human");
  });

  it("rule 4: breeze:wip on OPEN derives wip", () => {
    expect(
      classifyBreezeStatus({ labels: ["breeze:wip"], ghState: "OPEN" }),
    ).toBe("wip");
  });

  it("rule 5: no breeze:* labels on OPEN → new", () => {
    expect(classifyBreezeStatus({ labels: [], ghState: "OPEN" })).toBe("new");
  });

  it("rule 5: unrelated labels on OPEN → new", () => {
    expect(
      classifyBreezeStatus({
        labels: ["bug", "wontfix", "area:docs"],
        ghState: "OPEN",
      }),
    ).toBe("new");
  });

  it("rule 5: breeze:new label alone does NOT override (§2 subtleties)", () => {
    expect(
      classifyBreezeStatus({ labels: ["breeze:new"], ghState: "OPEN" }),
    ).toBe("new");
  });
});

describe("classifier — null / undefined ghState (Discussion et al.)", () => {
  it("null ghState + no breeze labels → new", () => {
    expect(classifyBreezeStatus({ labels: [], ghState: null })).toBe("new");
    expect(classifyBreezeStatus({ labels: [], ghState: undefined })).toBe("new");
  });
  it("null ghState + breeze:wip → wip (labels still drive derivation)", () => {
    expect(
      classifyBreezeStatus({ labels: ["breeze:wip"], ghState: null }),
    ).toBe("wip");
  });
  it("null ghState + breeze:human → human", () => {
    expect(
      classifyBreezeStatus({ labels: ["breeze:human"], ghState: null }),
    ).toBe("human");
  });
  it("null ghState + breeze:done → done", () => {
    expect(
      classifyBreezeStatus({ labels: ["breeze:done"], ghState: null }),
    ).toBe("done");
  });
});

describe("classifier — observable state-machine transitions (spec §1)", () => {
  // Each transition is expressed as a before/after pair: we classify the
  // "after" state with its label + gh_state snapshot, because the classifier
  // itself is stateless. The comment names the §1 transition.

  it("[*] → new: first-seen notification", () => {
    expect(classifyBreezeStatus({ labels: [], ghState: "OPEN" })).toBe("new");
  });

  it("new → wip: breeze:wip label added", () => {
    expect(
      classifyBreezeStatus({ labels: ["breeze:wip"], ghState: "OPEN" }),
    ).toBe("wip");
  });

  it("new → human: breeze:human label added", () => {
    expect(
      classifyBreezeStatus({ labels: ["breeze:human"], ghState: "OPEN" }),
    ).toBe("human");
  });

  it("new → done (via label): breeze:done added, still OPEN", () => {
    expect(
      classifyBreezeStatus({ labels: ["breeze:done"], ghState: "OPEN" }),
    ).toBe("done");
  });

  it("new → done (via gh_state): state flips to MERGED/CLOSED", () => {
    expect(classifyBreezeStatus({ labels: [], ghState: "MERGED" })).toBe("done");
    expect(classifyBreezeStatus({ labels: [], ghState: "CLOSED" })).toBe("done");
  });

  it("wip → human: label swap", () => {
    expect(
      classifyBreezeStatus({ labels: ["breeze:human"], ghState: "OPEN" }),
    ).toBe("human");
  });

  it("wip → done (via label swap)", () => {
    expect(
      classifyBreezeStatus({ labels: ["breeze:done"], ghState: "OPEN" }),
    ).toBe("done");
  });

  it("wip → done (via gh_state MERGED/CLOSED)", () => {
    expect(
      classifyBreezeStatus({ labels: ["breeze:wip"], ghState: "MERGED" }),
    ).toBe("done");
  });

  it("wip → new: all breeze:* labels removed while OPEN", () => {
    expect(classifyBreezeStatus({ labels: [], ghState: "OPEN" })).toBe("new");
  });

  it("human → wip: label swap", () => {
    expect(
      classifyBreezeStatus({ labels: ["breeze:wip"], ghState: "OPEN" }),
    ).toBe("wip");
  });

  it("human → done (label swap)", () => {
    expect(
      classifyBreezeStatus({ labels: ["breeze:done"], ghState: "OPEN" }),
    ).toBe("done");
  });

  it("human → done (gh_state MERGED/CLOSED)", () => {
    expect(
      classifyBreezeStatus({ labels: ["breeze:human"], ghState: "CLOSED" }),
    ).toBe("done");
  });

  it("human → new: all labels removed, still OPEN", () => {
    expect(classifyBreezeStatus({ labels: [], ghState: "OPEN" })).toBe("new");
  });

  it("done → new: breeze:done removed AND gh_state OPEN (reopen)", () => {
    expect(classifyBreezeStatus({ labels: [], ghState: "OPEN" })).toBe("new");
  });

  it("done → wip: reopen with breeze:wip", () => {
    expect(
      classifyBreezeStatus({ labels: ["breeze:wip"], ghState: "OPEN" }),
    ).toBe("wip");
  });

  it("done → human: reopen with breeze:human", () => {
    expect(
      classifyBreezeStatus({ labels: ["breeze:human"], ghState: "OPEN" }),
    ).toBe("human");
  });
});

describe("classifier — edge cases (spec §9)", () => {
  it("PR reopened after done: labels still drive, stays done (spec §9)", () => {
    // gh_state OPEN but breeze:done label still present → done wins.
    expect(
      classifyBreezeStatus({ labels: ["breeze:done"], ghState: "OPEN" }),
    ).toBe("done");
  });

  it("PR merged while breeze:human on it → done (not human)", () => {
    expect(
      classifyBreezeStatus({ labels: ["breeze:human"], ghState: "MERGED" }),
    ).toBe("done");
  });
});
