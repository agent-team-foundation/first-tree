let _config: unknown;

/** Store the resolved config as a singleton. Called by initConfig(). */
export function setConfig(config: unknown): void {
  _config = config;
}

/**
 * Get the resolved config singleton.
 * Must be called after initConfig().
 */
export function getConfig<T = unknown>(): T {
  if (_config === undefined) {
    throw new Error("Config not initialized. Call initConfig() first.");
  }
  // Type assertion: validated by Zod in initConfig()
  return _config as T;
}

/** Reset the config singleton. For testing only. */
export function resetConfig(): void {
  _config = undefined;
}
