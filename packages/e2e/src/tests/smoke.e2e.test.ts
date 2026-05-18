import { beforeAll, describe, expect, it } from "vitest";
import { type CurrentRunHandle, readCurrentHandle } from "../framework/current-handle.js";

let handle: CurrentRunHandle;

beforeAll(() => {
  // Reading inside beforeAll rather than at module scope keeps the error
  // path explicit: if globalSetup failed, vitest reports the setup failure
  // first instead of an opaque "cannot read .e2e-runs/current.json" import
  // error.
  handle = readCurrentHandle();
});

describe("M1 smoke — server + client come up against real pg", () => {
  it("server /healthz returns 200", async () => {
    const res = await fetch(`${handle.serverBaseUrl}/healthz`);
    expect(res.status).toBe(200);
  });

  it("server root path is reachable", async () => {
    const res = await fetch(`${handle.serverBaseUrl}/`);
    expect([200, 404]).toContain(res.status);
  });

  it("server /api/v1/health returns the structured health payload", async () => {
    const res = await fetch(`${handle.serverBaseUrl}/api/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string; db?: string };
    expect(body.status).toBe("ok");
    expect(body.db).toBe("connected");
  });
});
