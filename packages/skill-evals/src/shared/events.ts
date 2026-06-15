import { appendFileSync, existsSync, readFileSync } from "node:fs";

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (typeof item !== "string") return false;
  }
  return true;
}

export function appendEvent(eventsPath: string, event: JsonRecord): void {
  const withTimestamp: JsonRecord = {
    timestamp: new Date().toISOString(),
    ...event,
  };
  appendFileSync(eventsPath, `${JSON.stringify(withTimestamp)}\n`, "utf8");
}

export function readEvents(eventsPath: string): unknown[] {
  if (!existsSync(eventsPath)) return [];
  const text = readFileSync(eventsPath, "utf8");
  const events: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      events.push({ raw: trimmed, type: "unparsed_event" });
    }
  }
  return events;
}

export function previewText(value: string, maxLength = 4000): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...<truncated ${value.length - maxLength} chars>`;
}

export function findStringValue(value: unknown, predicate: (text: string) => boolean): boolean {
  if (typeof value === "string") return predicate(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (findStringValue(item, predicate)) return true;
    }
    return false;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      if (findStringValue(item, predicate)) return true;
    }
  }
  return false;
}

export function eventType(event: Record<string, unknown>): string | null {
  return typeof event.type === "string" ? event.type : null;
}

export function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function uniqueStrings(values: readonly string[]): string[] {
  const unique: string[] = [];
  for (const value of values) {
    if (!unique.includes(value)) unique.push(value);
  }
  return unique;
}
