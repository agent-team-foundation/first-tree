export function gitlabConnectionPollingInterval(input: {
  hasOneTimeSecret: boolean;
  connectionCount: number;
}): number | false {
  if (input.hasOneTimeSecret) return 4_000;
  return input.connectionCount > 0 ? 15_000 : false;
}
