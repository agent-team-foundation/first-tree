import { describe, expect, it } from "vitest";
import { listMeChatsQuerySchema } from "../schemas/me-chat.js";

describe("listMeChatsQuerySchema", () => {
  it("coerces comma-separated origin and participant filters", () => {
    const parsed = listMeChatsQuerySchema.parse({
      origin: "manual, github, ,feishu",
      with: "agent-a, agent-b,",
    });

    expect(parsed.origin).toEqual(["manual", "github", "feishu"]);
    expect(parsed.with).toEqual(["agent-a", "agent-b"]);
  });

  it("treats empty CSV filters as omitted", () => {
    const parsed = listMeChatsQuerySchema.parse({
      origin: " ",
      with: "",
    });

    expect(parsed.origin).toBeUndefined();
    expect(parsed.with).toBeUndefined();
  });

  it("passes through repeated query param arrays", () => {
    const parsed = listMeChatsQuerySchema.parse({
      origin: ["manual", "github"],
      with: ["agent-a", "agent-b"],
    });

    expect(parsed.origin).toEqual(["manual", "github"]);
    expect(parsed.with).toEqual(["agent-a", "agent-b"]);
  });

  it("coerces watching string query values", () => {
    expect(listMeChatsQuerySchema.parse({ watching: "1" }).watching).toBe(true);
    expect(listMeChatsQuerySchema.parse({ watching: "true" }).watching).toBe(true);
    expect(listMeChatsQuerySchema.parse({ watching: "0" }).watching).toBe(false);
    expect(listMeChatsQuerySchema.parse({ watching: "false" }).watching).toBe(false);
    expect(listMeChatsQuerySchema.parse({ watching: "" }).watching).toBe(false);
    expect(listMeChatsQuerySchema.parse({ watching: true }).watching).toBe(true);
  });
});
