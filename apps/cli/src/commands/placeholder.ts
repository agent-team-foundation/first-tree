import type { CommandAction, SubcommandModule } from "./types.js";

type PlaceholderConfig = {
  name: string;
  description: string;
  message: string;
  alias?: string;
  summary?: string;
};

export function createPlaceholderAction(message: string): CommandAction {
  return () => {
    console.log(message);
  };
}

export function createPlaceholderSubcommand(config: PlaceholderConfig): SubcommandModule {
  return {
    name: config.name,
    alias: config.alias ?? "",
    summary: config.summary ?? "",
    description: config.description,
    action: createPlaceholderAction(config.message),
  };
}
