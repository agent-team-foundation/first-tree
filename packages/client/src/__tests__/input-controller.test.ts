import { describe, expect, it } from "vitest";
import { InputController } from "../runtime/input-controller.js";

describe("InputController", () => {
  it("delivers pushed values via the async iterable", async () => {
    const ctrl = new InputController<string>();
    ctrl.push("a");
    ctrl.push("b");
    ctrl.end();

    const results: string[] = [];
    for await (const val of ctrl.iterable) {
      results.push(val);
    }
    expect(results).toEqual(["a", "b"]);
  });

  it("waits for push when buffer is empty", async () => {
    const ctrl = new InputController<string>();

    const iter = ctrl.iterable[Symbol.asyncIterator]();
    const p = iter.next();

    // Not yet resolved
    let resolved = false;
    p.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // Push resolves the waiting consumer
    ctrl.push("hello");
    const result = await p;
    expect(result).toEqual({ value: "hello", done: false });
  });

  it("end() terminates the iterable", async () => {
    const ctrl = new InputController<string>();
    ctrl.end();

    const iter = ctrl.iterable[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  it("end() is idempotent", async () => {
    const ctrl = new InputController<string>();
    ctrl.end();
    ctrl.end();

    const iter = ctrl.iterable[Symbol.asyncIterator]();
    expect(await iter.next()).toEqual({ value: undefined, done: true });
  });

  it("end() resolves a waiting consumer", async () => {
    const ctrl = new InputController<string>();

    const iter = ctrl.iterable[Symbol.asyncIterator]();
    const p = iter.next();

    ctrl.end();
    const result = await p;
    expect(result.done).toBe(true);
  });

  it("push after end is ignored", async () => {
    const ctrl = new InputController<string>();
    ctrl.push("a");
    ctrl.end();
    ctrl.push("b"); // should be ignored

    const results: string[] = [];
    for await (const val of ctrl.iterable) {
      results.push(val);
    }
    expect(results).toEqual(["a"]);
  });

  it("handles interleaved push and pull", async () => {
    const ctrl = new InputController<number>();
    const results: number[] = [];

    const consumer = (async () => {
      for await (const val of ctrl.iterable) {
        results.push(val);
      }
    })();

    ctrl.push(1);
    await new Promise((r) => setTimeout(r, 10));
    ctrl.push(2);
    await new Promise((r) => setTimeout(r, 10));
    ctrl.push(3);
    ctrl.end();

    await consumer;
    expect(results).toEqual([1, 2, 3]);
  });
});
