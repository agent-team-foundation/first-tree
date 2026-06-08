import type { FastifyInstance } from "fastify";
import * as semver from "semver";

export function clientCommandVersionHint(
  app: FastifyInstance,
  clientVersion: string | null | undefined,
): { serverCommandVersion?: string } {
  if (app.config.channel !== "dev" && app.config.channel !== "staging") return {};

  const currentVersion = semver.valid(clientVersion);
  const serverCommandVersion = semver.valid(app.commandVersion());
  if (currentVersion && serverCommandVersion && semver.lt(currentVersion, serverCommandVersion)) {
    return { serverCommandVersion };
  }
  return {};
}
