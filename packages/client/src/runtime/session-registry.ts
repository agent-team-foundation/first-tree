import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const REGISTRY_VERSION = 1;

type PersistedEntry = {
  claudeSessionId: string;
  lastActivity: string; // ISO 8601
  status: "active" | "suspended" | "evicted";
};

type RegistryData = {
  version: number;
  entries: Record<string, PersistedEntry>;
};

/**
 * SessionRegistry — persists `chatId → claudeSessionId` mappings to disk.
 *
 * Write strategy: debounced write-then-rename for atomicity.
 * On load, all entries start as `suspended`.
 */
export class SessionRegistry {
  private readonly filePath: string;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEntries: Map<string, { claudeSessionId: string; lastActivity: number; status: string }> | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Load the registry from disk. Returns entries map with persisted status. */
  load(): Map<string, { claudeSessionId: string; lastActivity: number; status: string }> {
    const result = new Map<string, { claudeSessionId: string; lastActivity: number; status: string }>();

    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data = JSON.parse(raw) as RegistryData;

      if (data.version !== REGISTRY_VERSION) {
        // Version mismatch — discard and start fresh
        return result;
      }

      for (const [chatId, entry] of Object.entries(data.entries)) {
        result.set(chatId, {
          claudeSessionId: entry.claudeSessionId,
          lastActivity: new Date(entry.lastActivity).getTime(),
          status: entry.status,
        });
      }
    } catch {
      // File doesn't exist or is corrupted — start fresh
    }

    return result;
  }

  /** Mark the registry as dirty; a debounced write will follow. */
  save(entries: Map<string, { claudeSessionId: string; lastActivity: number; status: string }>): void {
    this.pendingEntries = entries;
    if (!this.writeTimer) {
      this.writeTimer = setTimeout(() => {
        this.writeTimer = null;
        if (this.pendingEntries) {
          this.flush(this.pendingEntries);
          this.pendingEntries = null;
        }
      }, 1000);
    }
  }

  /** Force an immediate write (used during shutdown). */
  flush(entries: Map<string, { claudeSessionId: string; lastActivity: number; status: string }>): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }

    const data: RegistryData = {
      version: REGISTRY_VERSION,
      entries: {},
    };

    for (const [chatId, entry] of entries) {
      data.entries[chatId] = {
        claudeSessionId: entry.claudeSessionId,
        lastActivity: new Date(entry.lastActivity).toISOString(),
        status: entry.status as PersistedEntry["status"],
      };
    }

    const tmpPath = `${this.filePath}.tmp`;

    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      // Log but don't throw — registry persistence is best-effort
      process.stderr.write(
        `[session-registry] Failed to persist: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  /** Clean up timers. */
  dispose(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
  }
}
