import type { Command } from "commander";
import { registerDocCommentCommand } from "./comment.js";
import { registerDocCommentsCommand } from "./comments.js";
import { registerDocExportCommand } from "./export.js";
import { registerDocGetCommand } from "./get.js";
import { registerDocImportCommand } from "./import.js";
import { registerDocListCommand } from "./list.js";
import { registerDocPublishCommand } from "./publish.js";
import { registerDocReplyCommand } from "./reply.js";
import { registerDocResolveCommand } from "./resolve.js";
import { registerDocStatusCommand } from "./status.js";

export function registerDocCommands(program: Command): void {
  const doc = program
    .command("doc")
    .description(
      "Org document library (docloop) — publish markdown design docs, pull review comments, reply, " +
        "resolve, and track status",
    );
  registerDocPublishCommand(doc);
  registerDocGetCommand(doc);
  registerDocListCommand(doc);
  registerDocCommentsCommand(doc);
  registerDocCommentCommand(doc);
  registerDocReplyCommand(doc);
  registerDocResolveCommand(doc);
  registerDocStatusCommand(doc);
  registerDocImportCommand(doc);
  registerDocExportCommand(doc);
}
