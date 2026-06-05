import type { FastifyInstance } from "fastify";

export function clientCommandVersionHint(
  app: FastifyInstance,
  clientVersion: string | null | undefined,
): { serverCommandVersion?: string } {
  if (app.config.channel !== "dev" && app.config.channel !== "staging") return {};

  const serverCommandVersion = app.commandVersion();
  if (isUpdateAvailable(clientVersion, serverCommandVersion)) {
    return { serverCommandVersion };
  }
  return {};
}

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NUMERIC_IDENTIFIER_RE = /^(0|[1-9]\d*)$/;

function isUpdateAvailable(current: string | null | undefined, target: string | null | undefined): boolean {
  const currentVersion = parseVersion(current);
  const targetVersion = parseVersion(target);
  if (!currentVersion || !targetVersion) return false;
  return compareVersion(currentVersion, targetVersion) < 0;
}

function parseVersion(value: string | null | undefined): ParsedVersion | null {
  if (!value) return null;
  const match = SEMVER_RE.exec(value.trim());
  if (!match) return null;

  const major = parseInteger(match[1]);
  const minor = parseInteger(match[2]);
  const patch = parseInteger(match[3]);
  if (major === null || minor === null || patch === null) return null;

  const prerelease = match[4]?.split(".") ?? [];
  for (const identifier of prerelease) {
    if (/^\d+$/.test(identifier) && !NUMERIC_IDENTIFIER_RE.test(identifier)) return null;
  }

  return { major, minor, patch, prerelease };
}

function parseInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function compareVersion(left: ParsedVersion, right: ParsedVersion): number {
  const major = compareNumber(left.major, right.major);
  if (major !== 0) return major;
  const minor = compareNumber(left.minor, right.minor);
  if (minor !== 0) return minor;
  const patch = compareNumber(left.patch, right.patch);
  if (patch !== 0) return patch;
  return comparePrerelease(left.prerelease, right.prerelease);
}

function compareNumber(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const leftIdentifier = left[i];
    const rightIdentifier = right[i];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const comparison = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = NUMERIC_IDENTIFIER_RE.test(left);
  const rightNumeric = NUMERIC_IDENTIFIER_RE.test(right);
  if (leftNumeric && rightNumeric) return compareNumber(Number(left), Number(right));
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
