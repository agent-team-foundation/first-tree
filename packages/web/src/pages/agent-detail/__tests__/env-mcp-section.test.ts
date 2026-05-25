import { ENV_REDACTED_PLACEHOLDER, type EnvEntry } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { canKeepExistingSensitiveValue, envDialogInitialValue, resolveEnvDialogValue } from "../env-section.js";
import { formatMcpArgsInput, formatMcpHeadersInput, parseMcpArgsText, parseMcpHeadersText } from "../mcp-section.js";

describe("EnvSection sensitive value handling", () => {
  const persistedRedacted: EnvEntry = {
    key: "OPENAI_API_KEY",
    value: ENV_REDACTED_PLACEHOLDER,
    sensitive: true,
  };

  it("allows empty input to keep only persisted redacted sensitive values", () => {
    expect(canKeepExistingSensitiveValue(persistedRedacted, "unchanged")).toBe(true);
    expect(resolveEnvDialogValue({ value: "", sensitive: true, allowKeepExisting: true })).toEqual({
      ok: true,
      value: ENV_REDACTED_PLACEHOLDER,
    });
  });

  it("does not treat a newly added redacted-looking sensitive env as persisted", () => {
    expect(canKeepExistingSensitiveValue(persistedRedacted, "added")).toBe(false);
    expect(resolveEnvDialogValue({ value: "", sensitive: true, allowKeepExisting: false })).toEqual({
      ok: false,
      error: "Value is required for sensitive entries.",
    });
  });

  it("prefills unsaved sensitive plaintext instead of clearing it", () => {
    const unsaved: EnvEntry = { key: "TOKEN", value: "secret-value", sensitive: true };
    expect(envDialogInitialValue(unsaved, false)).toBe("secret-value");
  });
});

describe("McpSection structured args and headers", () => {
  it("round-trips stdio args with spaces and quotes through JSON array input", () => {
    const args = ["--label", "workspace with spaces", 'quoted "value"'];
    const formatted = formatMcpArgsInput(args);
    expect(parseMcpArgsText(formatted)).toEqual({ ok: true, value: args });
  });

  it("rejects non-string stdio args", () => {
    expect(parseMcpArgsText('["--port", 3000]')).toEqual({
      ok: false,
      error: "Args must be a JSON array of strings.",
    });
  });

  it("round-trips HTTP/SSE headers without dropping them", () => {
    const headers = {
      Authorization: "Bearer token",
      "X-Workspace": "default",
    };
    const formatted = formatMcpHeadersInput(headers);
    expect(parseMcpHeadersText(formatted)).toEqual({ ok: true, value: headers });
  });

  it("rejects header values that are not strings", () => {
    expect(parseMcpHeadersText('{"Authorization": 123}')).toEqual({
      ok: false,
      error: "Headers must be a JSON object with string values.",
    });
  });
});
