import { describe, expect, it } from "vitest";
import { connectTokenResponseSchema } from "../schemas/auth.js";

describe("connectTokenResponseSchema", () => {
  it("exposes only the channel-aware shell bootstrap fields", () => {
    expect(Object.keys(connectTokenResponseSchema.shape)).toEqual([
      "token",
      "expiresIn",
      "command",
      "bootstrapCommand",
      "installerUrl",
      "binName",
    ]);
  });
});
