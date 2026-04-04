/**
 * Minimal .env loader — no external dependencies.
 *
 * Reads KEY=VALUE pairs from .env at the project root.
 * Existing process.env values take precedence (never overwritten).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let loaded = false;

/**
 * Load .env from the project root into process.env.
 * Safe to call multiple times — only reads the file once.
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  // Walk up from this file to find the project root (where package.json lives)
  let dir = path.resolve(import.meta.dirname, '..', '..');
  const envPath = path.join(dir, '.env');

  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return; // No .env file — that's fine
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();

    // Don't overwrite existing env vars
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Get an env var with an optional fallback.
 * Automatically loads .env on first call.
 * Resolves ~ to the home directory for path values.
 */
export function getEnv(key: string, fallback?: string): string | undefined {
  loadEnv();
  const value = process.env[key] || fallback;
  if (value && value.startsWith('~')) {
    return path.join(os.homedir(), value.slice(1));
  }
  return value;
}
