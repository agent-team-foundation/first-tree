import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_VEIL_REASON_MAX_LENGTH,
  SessionVeilController,
  type SessionVeilSnapshot,
  type SessionVeilToken,
} from "../session-veil.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session veil", () => {
  it("publishes the veil synchronously before reconciliation can await", async () => {
    const controller = new SessionVeilController();
    const order: string[] = [];
    controller.subscribe((current) => order.push(`subscriber:${current.revision}:${current.veiled}`));

    const reconcile = async (): Promise<SessionVeilToken> => {
      const token = controller.begin("account_reconciliation");
      order.push("before-await");
      await Promise.resolve();
      order.push("after-await");
      return token;
    };
    const pending = reconcile();

    expect(order).toEqual(["subscriber:0:true", "subscriber:1:true", "before-await"]);
    const token = await pending;
    expect(order.at(-1)).toBe("after-await");
    expect(controller.reveal(token)).toBe(true);
    expect(controller.getSnapshot()).toEqual({ revision: 2, veiled: false, reason: null });
  });

  it("does not let an older operation reveal through a newer veil", () => {
    const controller = new SessionVeilController();
    const first = controller.begin("first_reconciliation");
    const second = controller.begin("second_reconciliation");

    expect(controller.reveal(first)).toBe(false);
    expect(controller.getSnapshot()).toEqual({ revision: 2, veiled: true, reason: "second_reconciliation" });
    expect(controller.reveal(second)).toBe(true);
    expect(controller.getSnapshot()).toEqual({ revision: 3, veiled: false, reason: null });
  });

  it("keeps token authority module-private and rejects reflected or cross-controller capabilities", () => {
    const controller = new SessionVeilController();
    const other = new SessionVeilController();
    const token = controller.begin("identity_check");
    const reflected = Object.freeze({ ...token }) as unknown as SessionVeilToken;
    const forged = Object.freeze(Object.create(null)) as SessionVeilToken;

    expect(Reflect.ownKeys(token)).toEqual([]);
    expect(Object.getPrototypeOf(token)).toBeNull();
    expect(controller.reveal(reflected)).toBe(false);
    expect(controller.reveal(forged)).toBe(false);
    expect(other.reveal(token)).toBe(false);
    expect(controller.getSnapshot().veiled).toBe(true);
    expect(controller.reveal(token)).toBe(true);
  });

  it("emits immutable snapshots in subscriber order and supports idempotent disposal", () => {
    const controller = new SessionVeilController("initial");
    const events: string[] = [];
    const snapshots: SessionVeilSnapshot[] = [];
    const disposeFirst = controller.subscribe((current) => {
      events.push(`first:${current.revision}`);
      snapshots.push(current);
    });
    const disposeSecond = controller.subscribe((current) => events.push(`second:${current.revision}`));

    const token = controller.begin("organization_reconciliation");
    disposeFirst();
    disposeFirst();
    expect(controller.keepVeiled(token, "selection_required")).toBe(true);
    disposeSecond();
    controller.begin("later_reconciliation");

    expect(events).toEqual(["first:0", "second:0", "first:1", "second:1", "second:2"]);
    expect(snapshots.every(Object.isFrozen)).toBe(true);
    expect(snapshots.map(({ revision }) => revision)).toEqual([0, 1]);
  });

  it("coalesces a reentrant veil before another subscriber can observe stale revealed state", () => {
    const controller = new SessionVeilController();
    const error = new Error("listener failed");
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const events: string[] = [];
    let reentered = false;
    controller.subscribe((current) => {
      if (current.revision === 2 && !reentered) {
        reentered = true;
        controller.begin("urgent_reconciliation");
        events.push(`first-after-begin:${current.revision}:${controller.getSnapshot().revision}`);
      }
    });
    controller.subscribe((current) => {
      if (current.revision === 3) throw error;
    });
    controller.subscribe((current) => {
      if (current.revision > 1) events.push(`last:${current.revision}:${current.veiled}`);
    });

    const ready = controller.begin("ready");
    expect(controller.reveal(ready)).toBe(true);

    expect(events).toEqual(["first-after-begin:2:3", "last:3:true"]);
    expect(reportError).toHaveBeenCalledExactlyOnceWith(error);
    expect(controller.getSnapshot()).toEqual({ revision: 3, veiled: true, reason: "urgent_reconciliation" });
  });

  it("settles failures without revealing and bounds the published reason", () => {
    const controller = new SessionVeilController();
    const token = controller.begin("active_me");
    const longReason = `failed_${"x".repeat(SESSION_VEIL_REASON_MAX_LENGTH * 2)}`;

    expect(controller.fail(token, longReason)).toBe(true);
    const failed = controller.getSnapshot();
    expect(failed.veiled).toBe(true);
    expect(failed.reason).toBe(longReason.slice(0, SESSION_VEIL_REASON_MAX_LENGTH));
    expect(failed.reason).toHaveLength(SESSION_VEIL_REASON_MAX_LENGTH);
    expect(controller.reveal(token)).toBe(false);
    expect(controller.keepVeiled(token)).toBe(false);
  });
});
