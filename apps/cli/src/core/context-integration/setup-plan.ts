import {
  type ContextIntegrationProject,
  type ContextIntegrationProvider,
  portableCliExecutable,
} from "@first-tree/shared";
import { channelConfig } from "../channel.js";
import { quotePosixShellArg } from "../posix-shell.js";
import type { ContextSetupLocation } from "./client-preflight.js";

export type ContextSetupChoice = {
  kind: "global" | "directory" | "session";
  label: string;
  available: boolean;
  recommended: boolean;
  description: string;
  applyCommand: string | null;
};

type ContextSetupCommandIdentity = {
  provider: ContextIntegrationProvider;
  teamId: string;
  planId: string;
};

export function buildContextSetupChoices(
  location: ContextSetupLocation,
  command: ContextSetupCommandIdentity,
): ContextSetupChoice[] {
  return [
    {
      kind: "global",
      label: "All sessions",
      available: true,
      recommended: !location.temporaryDirectory,
      description: "Make this Team eligible in every session for this provider.",
      applyCommand: renderApplyCommand(command, location.project, "global"),
    },
    {
      kind: "directory",
      label: location.directory ? `This directory: ${location.directory}` : "This directory",
      available: location.directoryAvailable,
      recommended: location.directoryAvailable && !location.temporaryDirectory,
      description: location.directoryAvailable
        ? "Make this Team eligible in this directory and its descendants."
        : "Unavailable because the provider did not expose a stable directory.",
      applyCommand: location.directoryAvailable ? renderApplyCommand(command, location.project, "directory") : null,
    },
    {
      kind: "session",
      label: "This session only",
      available: true,
      recommended: location.temporaryDirectory,
      description: "Use verified Read/Write Skills now without installing a Plugin, Hook, or persistent grant.",
      applyCommand: renderApplyCommand(command, location.project, "session"),
    },
  ];
}

function renderApplyCommand(
  command: ContextSetupCommandIdentity,
  project: ContextIntegrationProject,
  scope: ContextSetupChoice["kind"],
): string {
  const executable =
    channelConfig.channel === "dev"
      ? quotePosixShellArg(channelConfig.binName)
      : portableCliExecutable(channelConfig.binName);
  const projectSelector = project.kind === "path" ? `--project-root ${quotePosixShellArg(project.root)}` : "--pathless";
  return [
    `${executable} --json context enable`,
    `--provider ${quotePosixShellArg(command.provider)}`,
    `--team ${quotePosixShellArg(command.teamId)}`,
    projectSelector,
    `--scope ${quotePosixShellArg(scope)}`,
    `--plan-id ${quotePosixShellArg(command.planId)}`,
    "--yes",
  ].join(" ");
}
