import type { Command } from "commander";
import { registerGitlabFollowCommand } from "./follow.js";
import { registerGitlabFollowingCommand } from "./following.js";
import { registerGitlabUnfollowCommand } from "./unfollow.js";

export function registerGitlabCommands(program: Command): void {
  const gitlab = program
    .command("gitlab")
    .description(
      "GitLab Issue/MR chat attention — local pending follow declarations activated by inbound webhooks. " +
        "No Cloud-to-GitLab API calls and no GitHub-style rebind semantics.",
    );
  registerGitlabFollowCommand(gitlab);
  registerGitlabFollowingCommand(gitlab);
  registerGitlabUnfollowCommand(gitlab);
}
