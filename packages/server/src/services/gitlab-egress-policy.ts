import { lookup as dnsLookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

export type GitlabEgressAllowlistEntry = {
  origin: string;
  addressPolicy: { kind: "public" } | { kind: "cidrs"; cidrs: string[] };
};

export type GitlabPinnedDestination = {
  origin: string;
  hostname: string;
  port: number;
  addresses: string[];
  pinnedAddress: string;
  curlResolve: string;
};

export type GitlabDnsLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

const PERMANENTLY_BLOCKED_RANGES = new Set([
  "unspecified",
  "broadcast",
  "multicast",
  "linkLocal",
  "loopback",
  "reserved",
]);
const PERMANENTLY_BLOCKED_ADDRESSES = new Set([
  // Alibaba Cloud ECS metadata. Other major cloud metadata endpoints live in
  // link-local ranges already rejected above.
  "100.100.100.200",
]);

export function normalizeAuthorizedGitlabOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("GitLab egress origin must be an exact credential-free HTTPS origin");
  }
  return url.origin.toLowerCase();
}

export function assertGitlabEgressAllowlistValid(entries: readonly GitlabEgressAllowlistEntry[]): void {
  const origins = new Set<string>();
  for (const entry of entries) {
    const origin = normalizeAuthorizedGitlabOrigin(entry.origin);
    if (origins.has(origin)) throw new Error(`Duplicate GitLab egress origin: ${origin}`);
    origins.add(origin);
    if (entry.addressPolicy.kind === "cidrs") {
      if (entry.addressPolicy.cidrs.length === 0) {
        throw new Error(`GitLab egress CIDR policy for ${origin} must not be empty`);
      }
      for (const cidr of entry.addressPolicy.cidrs) {
        let parsed: [ipaddr.IPv4 | ipaddr.IPv6, number];
        try {
          parsed = ipaddr.parseCIDR(cidr);
        } catch {
          throw new Error(`Invalid GitLab egress CIDR for ${origin}: ${cidr}`);
        }
        if (isPermanentlyBlocked(parsed[0])) {
          throw new Error(`GitLab egress CIDR cannot authorize a permanently blocked range: ${cidr}`);
        }
      }
    }
  }
}

export function isGitlabOriginAuthorized(entries: readonly GitlabEgressAllowlistEntry[], origin: string): boolean {
  let normalized: string;
  try {
    normalized = normalizeAuthorizedGitlabOrigin(origin);
  } catch {
    return false;
  }
  return entries.some((entry) => normalizeAuthorizedGitlabOrigin(entry.origin) === normalized);
}

export async function resolveAuthorizedGitlabDestination(
  entries: readonly GitlabEgressAllowlistEntry[],
  origin: string,
  lookup: GitlabDnsLookup = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
): Promise<GitlabPinnedDestination> {
  assertGitlabEgressAllowlistValid(entries);
  const normalized = normalizeAuthorizedGitlabOrigin(origin);
  const entry = entries.find((candidate) => normalizeAuthorizedGitlabOrigin(candidate.origin) === normalized);
  if (!entry) throw new GitlabEgressPolicyError("origin_not_authorized");
  const url = new URL(normalized);
  let answers: ReadonlyArray<{ address: string; family: number }>;
  try {
    answers = await lookup(url.hostname);
  } catch {
    throw new GitlabEgressPolicyError("dns_unavailable");
  }
  if (answers.length === 0) throw new GitlabEgressPolicyError("dns_unavailable");
  let addresses: string[];
  try {
    addresses = [...new Set(answers.map((answer) => canonicalAddress(answer.address)))];
  } catch {
    throw new GitlabEgressPolicyError("address_not_authorized");
  }
  if (addresses.some((address) => !addressAllowedByPolicy(address, entry.addressPolicy))) {
    throw new GitlabEgressPolicyError("address_not_authorized");
  }
  const pinnedAddress = addresses[0];
  if (!pinnedAddress) throw new GitlabEgressPolicyError("dns_unavailable");
  const port = url.port ? Number(url.port) : 443;
  const curlAddress = ipaddr.parse(pinnedAddress).kind() === "ipv6" ? `[${pinnedAddress}]` : pinnedAddress;
  return {
    origin: normalized,
    hostname: url.hostname,
    port,
    addresses,
    pinnedAddress,
    curlResolve: `${url.hostname}:${port}:${curlAddress}`,
  };
}

export class GitlabEgressPolicyError extends Error {
  constructor(readonly reason: "origin_not_authorized" | "dns_unavailable" | "address_not_authorized") {
    super(`GitLab snapshot egress denied: ${reason}`);
    this.name = "GitlabEgressPolicyError";
  }
}

function addressAllowedByPolicy(raw: string, policy: GitlabEgressAllowlistEntry["addressPolicy"]): boolean {
  const address = normalizedParsedAddress(raw);
  if (isPermanentlyBlocked(address) || PERMANENTLY_BLOCKED_ADDRESSES.has(address.toNormalizedString())) {
    return false;
  }
  if (policy.kind === "public") return address.range() === "unicast";
  return policy.cidrs.some((cidr) => {
    const [network, prefix] = ipaddr.parseCIDR(cidr);
    const normalizedNetwork = normalizeParsedAddress(network);
    return address.kind() === normalizedNetwork.kind() && address.match(normalizedNetwork, prefix);
  });
}

function isPermanentlyBlocked(address: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  return PERMANENTLY_BLOCKED_RANGES.has(normalizeParsedAddress(address).range());
}

function canonicalAddress(raw: string): string {
  return normalizedParsedAddress(raw).toNormalizedString();
}

function normalizedParsedAddress(raw: string): ipaddr.IPv4 | ipaddr.IPv6 {
  return normalizeParsedAddress(ipaddr.parse(raw));
}

function normalizeParsedAddress(address: ipaddr.IPv4 | ipaddr.IPv6): ipaddr.IPv4 | ipaddr.IPv6 {
  if (address.kind() !== "ipv6") return address;
  const ipv6 = address as ipaddr.IPv6;
  return ipv6.isIPv4MappedAddress() ? ipv6.toIPv4Address() : ipv6;
}
