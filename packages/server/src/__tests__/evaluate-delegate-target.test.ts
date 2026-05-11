import { describe, expect, it } from "vitest";
import { evaluateDelegateTarget } from "../api/webhooks/github.js";

describe("evaluateDelegateTarget", () => {
  const orgA = "org-aaaaaa";
  const orgB = "org-bbbbbb";

  it("returns 'ok' for an active same-org target", () => {
    expect(evaluateDelegateTarget({ organizationId: orgA, status: "active" }, orgA)).toBe("ok");
  });

  it("returns 'not_found' for an undefined target (uuid did not resolve)", () => {
    expect(evaluateDelegateTarget(undefined, orgA)).toBe("not_found");
  });

  it("returns 'cross_org' before checking status (cross-org shadows the inactive verdict)", () => {
    // Ordering matters: an admin who reads the log line "cross_org" knows to
    // fix the configuration; "inactive" would mislead them into reactivating
    // a foreign-org agent that has no business being a delegate at all.
    expect(evaluateDelegateTarget({ organizationId: orgB, status: "suspended" }, orgA)).toBe("cross_org");
  });

  it("returns 'inactive' for a same-org target whose status is not 'active'", () => {
    expect(evaluateDelegateTarget({ organizationId: orgA, status: "suspended" }, orgA)).toBe("inactive");
    expect(evaluateDelegateTarget({ organizationId: orgA, status: "deleted" }, orgA)).toBe("inactive");
  });

  it("returns 'cross_org' for a same-uuid org id mismatch (case-sensitive comparison)", () => {
    // Defensive: org ids are uuids, but the comparison is a literal `!==`,
    // so a hypothetical case-mangled id would be treated as a different org.
    expect(evaluateDelegateTarget({ organizationId: orgA.toUpperCase(), status: "active" }, orgA)).toBe("cross_org");
  });
});
