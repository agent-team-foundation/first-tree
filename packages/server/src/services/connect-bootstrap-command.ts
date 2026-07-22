import { buildLoginCommand, buildPortableBootstrapCommand } from "@first-tree/shared";
import { type ChannelName, getChannelConfig } from "@first-tree/shared/channel";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolvePublicUrl } from "../utils/public-url.js";

export type ServerConnectBootstrapCommand = {
  command: string;
  bootstrapCommand: string;
  installerUrl: string | null;
  binName: string;
};

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * Build the deployment-authoritative connect command for a request. Both the
 * real connect-token response and public non-authenticating preview template
 * use this path so mirror, channel, binary, and public-server overrides cannot
 * drift between Web and Server.
 */
export function buildServerConnectBootstrapCommand(options: {
  app: FastifyInstance;
  request: FastifyRequest;
  token: string;
  channel?: ChannelName;
}): ServerConnectBootstrapCommand {
  const channel = options.channel ?? options.app.config.channel;
  const channelConfig = getChannelConfig(channel);
  const issuer = resolvePublicUrl(options.app, options.request);
  const command = buildLoginCommand({
    executable: channelConfig.binName,
    tokenArg: options.token,
    serverUrl: issuer,
    defaultServerUrl: channelConfig.defaultServerUrl,
  });

  if (channel === "dev") {
    return {
      command,
      bootstrapCommand: command,
      installerUrl: null,
      binName: channelConfig.binName,
    };
  }

  const installerPath = channelConfig.portable.publicInstallerPath;
  const defaultPortableDownloadBaseUrl = channelConfig.portable.downloadBaseUrl;
  if (installerPath === null || defaultPortableDownloadBaseUrl === null) {
    throw new Error(`Portable installer metadata is missing for the ${channel} channel`);
  }
  const portableDownloadBaseUrl = options.app.config.connectBootstrap.portableDownloadBaseUrl;
  const installerUrl = joinUrl(portableDownloadBaseUrl, installerPath);
  const bootstrapCommand = buildPortableBootstrapCommand({
    installerUrl,
    portableDownloadBaseUrl,
    defaultPortableDownloadBaseUrl,
    binName: channelConfig.binName,
    token: options.token,
    serverUrl: issuer,
    defaultServerUrl: channelConfig.defaultServerUrl,
  });
  return {
    command,
    bootstrapCommand,
    installerUrl,
    binName: channelConfig.binName,
  };
}
