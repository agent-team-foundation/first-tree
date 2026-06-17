import type { Command } from "commander";
import { registerGithubFollowCommand } from "./follow.js";
import { registerGithubFollowingCommand } from "./following.js";
import { registerGithubUnfollowCommand } from "./unfollow.js";

export function registerGithubCommands(program: Command): void {
  const github = program
    .command("github")
    .description(
      "GitHub entity attention — follow / unfollow / following. Follow wires an entity's webhook events " +
        "into the current chat; unfollow explicitly stops this chat from tracking the entity. One line, one room: a " +
        "(human, delegate) line lives in exactly one chat (409 → --rebind moves it, never duplicates).",
    );
  registerGithubFollowCommand(github);
  registerGithubUnfollowCommand(github);
  registerGithubFollowingCommand(github);
}
