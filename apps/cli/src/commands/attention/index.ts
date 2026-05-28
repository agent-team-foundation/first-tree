import type { Command } from "commander";
import { registerAttentionCancelCommand } from "./cancel.js";
import { registerAttentionListCommand } from "./list.js";
import { registerAttentionRaiseCommand } from "./raise.js";
import { registerAttentionRespondCommand } from "./respond.js";
import { registerAttentionShowCommand } from "./show.js";

export function registerAttentionCommands(program: Command): void {
  const attention = program
    .command("attention")
    .description("Need-Human-Attention (NHA) — raise / list / show / cancel / respond");
  registerAttentionRaiseCommand(attention);
  registerAttentionListCommand(attention);
  registerAttentionShowCommand(attention);
  registerAttentionCancelCommand(attention);
  registerAttentionRespondCommand(attention);
}
