import { describe, expect, it } from "vitest";
import {
  assertGitlabEgressAllowlistValid,
  type GitlabEgressPolicyError,
  isGitlabOriginAuthorized,
  resolveAuthorizedGitlabDestination,
} from "../services/gitlab-egress-policy.js";

const publicEntry = {
  origin: "https://gitlab.example:8443",
  addressPolicy: { kind: "public" as const },
};

describe("GitLab snapshot egress policy", () => {
  it("matches exact normalized HTTPS origin including port", () => {
    expect(isGitlabOriginAuthorized([publicEntry], "https://GITLAB.EXAMPLE:8443")).toBe(true);
    expect(isGitlabOriginAuthorized([publicEntry], "https://gitlab.example")).toBe(false);
    expect(isGitlabOriginAuthorized([publicEntry], "http://gitlab.example:8443")).toBe(false);
    expect(isGitlabOriginAuthorized([publicEntry], "https://sub.gitlab.example:8443")).toBe(false);
  });

  it("accepts every public A/AAAA result and returns a TLS-host-preserving curl pin", async () => {
    const result = await resolveAuthorizedGitlabDestination([publicEntry], publicEntry.origin, async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    expect(result).toMatchObject({
      origin: publicEntry.origin,
      hostname: "gitlab.example",
      port: 8443,
      addresses: ["8.8.8.8", "2606:4700:4700:0:0:0:0:1111"],
      pinnedAddress: "8.8.8.8",
      curlResolve: "gitlab.example:8443:8.8.8.8",
    });
  });

  it("rejects the full result set when one answer is private under public policy", async () => {
    await expect(
      resolveAuthorizedGitlabDestination([publicEntry], publicEntry.origin, async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.20.1.4", family: 4 },
      ]),
    ).rejects.toMatchObject({ reason: "address_not_authorized" } satisfies Partial<GitlabEgressPolicyError>);
  });

  it("supports operator-authorized IPv4 and IPv6 private ranges", async () => {
    const entry = {
      origin: "https://gitlab.company.local",
      addressPolicy: { kind: "cidrs" as const, cidrs: ["10.20.0.0/16", "fd12:3456::/32"] },
    };
    await expect(
      resolveAuthorizedGitlabDestination([entry], entry.origin, async () => [
        { address: "10.20.4.7", family: 4 },
        { address: "fd12:3456::7", family: 6 },
      ]),
    ).resolves.toMatchObject({ pinnedAddress: "10.20.4.7" });
  });

  it("never allows cloud metadata addresses, even through an explicit CIDR", async () => {
    const entry = {
      origin: "https://gitlab.company.local",
      addressPolicy: { kind: "cidrs" as const, cidrs: ["100.64.0.0/10"] },
    };
    await expect(
      resolveAuthorizedGitlabDestination([entry], entry.origin, async () => [
        { address: "100.100.100.200", family: 4 },
      ]),
    ).rejects.toMatchObject({ reason: "address_not_authorized" });
  });

  it.each([
    "127.0.0.0/8",
    "169.254.0.0/16",
    "0.0.0.0/8",
    "224.0.0.0/4",
    "192.0.2.0/24",
    "::1/128",
    "fe80::/10",
    "::/128",
    "ff00::/8",
  ])("fails startup validation for permanently blocked CIDR %s", (cidr) => {
    expect(() =>
      assertGitlabEgressAllowlistValid([
        {
          origin: "https://gitlab.internal",
          addressPolicy: { kind: "cidrs", cidrs: [cidr] },
        },
      ]),
    ).toThrow(/permanently blocked range/u);
  });

  it("fails closed for duplicate origins, malformed CIDRs, and DNS failure", async () => {
    expect(() => assertGitlabEgressAllowlistValid([publicEntry, publicEntry])).toThrow(/Duplicate/u);
    expect(() =>
      assertGitlabEgressAllowlistValid([
        {
          origin: "https://gitlab.internal",
          addressPolicy: { kind: "cidrs", cidrs: ["not-a-cidr"] },
        },
      ]),
    ).toThrow(/Invalid GitLab egress CIDR/u);
    await expect(
      resolveAuthorizedGitlabDestination([publicEntry], publicEntry.origin, async () => []),
    ).rejects.toMatchObject({ reason: "dns_unavailable" } satisfies Partial<GitlabEgressPolicyError>);
    await expect(
      resolveAuthorizedGitlabDestination([publicEntry], publicEntry.origin, async () => {
        throw new Error("resolver failed");
      }),
    ).rejects.toMatchObject({ reason: "dns_unavailable" });
    await expect(
      resolveAuthorizedGitlabDestination([publicEntry], publicEntry.origin, async () => [
        { address: "not-an-ip", family: 4 },
      ]),
    ).rejects.toMatchObject({ reason: "address_not_authorized" });
  });
});
