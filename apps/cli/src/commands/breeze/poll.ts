import type { SubcommandModule } from "../types.js";

export function runPollCommand(): void {
  console.log("first-tree breeze poll is not implemented yet.");
}

export const pollCommand: SubcommandModule = {
  name: "poll",
  alias: "",
  summary: "",
  description: "Poll breeze workflow state.",
  action: runPollCommand,
};
