import type { Command } from "commander";
import { registerCronCreateCommand } from "./create.js";
import { registerCronDeleteCommand } from "./delete.js";
import { registerCronListCommand } from "./list.js";
import { registerCronPauseCommand } from "./pause.js";
import { registerCronPreviewCommand } from "./preview.js";
import { registerCronResumeCommand } from "./resume.js";
import { registerCronShowCommand } from "./show.js";
import { registerCronUpdateCommand } from "./update.js";

export function registerCronCommands(program: Command): void {
  const cron = program
    .command("cron")
    .description(
      "Scheduled jobs — preview, create, list, show, update, pause, resume, and delete cron-triggered messages in the current chat. " +
        "Every cron command requires FIRST_TREE_CHAT_ID from the agent session.",
    );
  registerCronPreviewCommand(cron);
  registerCronCreateCommand(cron);
  registerCronListCommand(cron);
  registerCronShowCommand(cron);
  registerCronUpdateCommand(cron);
  registerCronPauseCommand(cron);
  registerCronResumeCommand(cron);
  registerCronDeleteCommand(cron);
}
