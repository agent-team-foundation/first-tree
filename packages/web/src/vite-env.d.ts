/// <reference types="vite/client" />

/**
 * Build id injected by Vite's `define` (see vite.config.ts). Identifies the
 * web build THIS tab is running; compared against `dist/version.json` to
 * detect a newer deployed build.
 */
declare const __WEB_BUILD_ID__: string;

interface ImportMetaEnv {
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_ENABLED?: string;
  readonly VITE_SENTRY_ENVIRONMENT?: string;
  readonly VITE_SENTRY_RELEASE?: string;
  readonly VITE_SENTRY_TRACES_SAMPLE_RATE?: string;
}
