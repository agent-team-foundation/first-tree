import { describe, expect, it } from "vitest";
import { googleExternalProfile, normalizeExternalProfile, normalizeUsername } from "../external-account.js";

describe("external account normalization", () => {
  it.each([
    ["OctoCat", "octocat"],
    ["first.last", "first-last"],
    ["first_last", "first-last"],
    ["  ACME User  ", "acme-user"],
    ["Jöhn Döe", "john-doe"],
    ["😀", "google-user"],
    ["", "google-user"],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeUsername(input, "google-user")).toBe(expected);
  });

  it("uses a verified Google email local part before display name", () => {
    const profile = googleExternalProfile({
      sub: "subject-1",
      email: "First.Last@workspace.example",
      emailVerified: true,
      name: "Display Name",
    });
    expect(normalizeExternalProfile(profile)).toEqual({ username: "first-last", displayName: "Display Name" });
  });

  it("does not use an unverified Google email as a username candidate", () => {
    const profile = googleExternalProfile({ sub: "subject-1", email: "owner@gmail.com", name: "Owner Name" });
    expect(normalizeExternalProfile(profile).username).toBe("owner-name");
  });

  it("reserves suffix space for long values", () => {
    expect(normalizeUsername("a".repeat(200), "user").length).toBe(87);
  });
});
