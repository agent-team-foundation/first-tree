import type { FastifyReply, FastifyRequest } from "fastify";
import { ForbiddenError, UnauthorizedError } from "../errors.js";

const GITHUB_API_URL = "https://api.github.com/user";

export type GitHubIdentity = {
  username: string;
};

/**
 * Middleware that validates a GitHub token from the `X-GitHub-Token` header.
 * On success, sets `request.githubUser = { username }`.
 */
export function githubAuthHook() {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = request.headers["x-github-token"];
    if (!token || typeof token !== "string") {
      throw new UnauthorizedError("Missing X-GitHub-Token header");
    }

    const res = await fetch(GITHUB_API_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!res.ok) {
      throw new UnauthorizedError("Invalid GitHub token");
    }

    const data = (await res.json()) as { login?: string };
    if (!data.login) {
      throw new ForbiddenError("Could not determine GitHub username from token");
    }

    request.githubUser = { username: data.login };
  };
}
