import { describe, expect, it } from "vitest";
import {
  captureDestination,
  FIRST_TREE_ATTR,
  recordingDestination,
  silentDestination,
  TRACING_SENSITIVE_KEY_PATTERNS,
} from "../index.js";

describe("observability testing helpers", () => {
  it("creates a silent writable destination", () => {
    const dest = silentDestination();

    expect(dest.write("ignored\n")).toBe(true);
  });

  it("records JSON log lines and ignores non-JSON chunks", () => {
    const { dest, records } = recordingDestination();

    dest.write(`${JSON.stringify({ level: 30, msg: "ok" })}\n`);
    dest.write("not json\n");

    expect(records).toEqual([{ level: 30, msg: "ok" }]);
  });

  it("captures formatted logger output", () => {
    const { dest, read } = captureDestination(() => "pretty");

    dest.write(`${JSON.stringify({ level: 30, time: "t", msg: "hello", module: "test" })}\n`);

    expect(read()).toContain("INFO");
    expect(read()).toContain("[test]");
    expect(read()).toContain("hello");
  });
});

describe("tracing attributes", () => {
  it("exports stable tracing attribute names and sensitive key patterns", () => {
    expect(FIRST_TREE_ATTR.ORGANIZATION_ID).toBe("organization.id");
    expect(FIRST_TREE_ATTR.HTTP_REQUEST_BODY).toBe("http.request.body");
    expect(TRACING_SENSITIVE_KEY_PATTERNS).toContain("password");
    expect(TRACING_SENSITIVE_KEY_PATTERNS).toContain("session_secret");
  });
});
