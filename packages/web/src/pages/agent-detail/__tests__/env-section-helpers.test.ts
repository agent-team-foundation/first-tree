import { ENV_REDACTED_PLACEHOLDER, type EnvEntry } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { canKeepExistingSensitiveValue, envDialogInitialValue, resolveEnvDialogValue } from "../env-section.js";

describe("EnvSection sensitive value handling", () => {
  const persistedRedacted: EnvEntry = {
    key: "OPENAI_API_KEY",
    value: ENV_REDACTED_PLACEHOLDER,
    sensitive: true,
  };

  it("lets a persisted redacted sensitive value keep its existing ciphertext", () => {
    expect(canKeepExistingSensitiveValue(persistedRedacted)).toBe(true);
    expect(resolveEnvDialogValue({ value: "", sensitive: true, allowKeepExisting: true })).toEqual({
      ok: true,
      value: ENV_REDACTED_PLACEHOLDER,
    });
  });

  it("does not let a sensitive plaintext value or a non-sensitive value keep-existing", () => {
    expect(canKeepExistingSensitiveValue({ key: "TOKEN", value: "secret", sensitive: true })).toBe(false);
    expect(canKeepExistingSensitiveValue({ key: "MODE", value: ENV_REDACTED_PLACEHOLDER, sensitive: false })).toBe(
      false,
    );
  });

  it("requires a value when a sensitive entry can't keep an existing one", () => {
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
