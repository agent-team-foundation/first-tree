import * as Sentry from "@sentry/react";
import type { ErrorInfo } from "react";
import { PROD_HOST, sanitizePath } from "../analytics.js";

const DEFAULT_SAMPLE_RATE = 0.1;
const FALSE_VALUES = new Set(["0", "false", "off", "no"]);
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_RE =
  /token|secret|password|credential|authorization|cookie|jwt|api[_-]?key|access[_-]?token|refresh[_-]?token|oauth[_-]?code/i;
const ROUTE_TEXT_RE = /\/(?:invite\/[^\s"'<>)]*|auth\/(?:github\/)?complete[^\s"'<>)]*)/g;
const ABSOLUTE_URL_TEXT_RE = /https?:\/\/[^\s"'<>)]*/gi;

type WebSentryConfig = {
  enabled: boolean;
  dsn?: string;
  environment: string;
  release: string;
  buildId: string;
  sampleRate: number;
};

export function resolveWebSentryConfig(env: ImportMetaEnv = import.meta.env): WebSentryConfig {
  const rawDsn = env.VITE_SENTRY_DSN?.trim();
  const rawEnabled = env.VITE_SENTRY_ENABLED?.trim().toLowerCase();
  return {
    enabled: rawEnabled ? !FALSE_VALUES.has(rawEnabled) : Boolean(rawDsn),
    dsn: rawDsn || undefined,
    environment: env.VITE_SENTRY_ENVIRONMENT?.trim() || defaultEnvironment(),
    release: env.VITE_SENTRY_RELEASE?.trim() || `first-tree-web@${__WEB_BUILD_ID__}`,
    buildId: __WEB_BUILD_ID__,
    sampleRate: parseSampleRate(env.VITE_SENTRY_TRACES_SAMPLE_RATE, DEFAULT_SAMPLE_RATE),
  };
}

export function initWebSentry(): void {
  const config = resolveWebSentryConfig();
  if (!config.enabled || !config.dsn) return;

  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    tracesSampleRate: config.sampleRate,
    sendDefaultPii: false,
    maxBreadcrumbs: 0,
    beforeSend(event) {
      return sanitizeWebSentryEvent(event, config);
    },
    beforeSendTransaction(event) {
      return sanitizeWebSentryEvent(event, config);
    },
  });
  Sentry.setTag("first_tree.surface", "web");
  Sentry.setTag("first_tree.git_sha", config.buildId);
}

export function captureReactRootError(error: unknown, errorInfo?: ErrorInfo): void {
  if (!Sentry.isEnabled()) return;
  Sentry.withScope((scope) => {
    if (errorInfo?.componentStack) {
      scope.setContext("react", { componentStack: errorInfo.componentStack });
    }
    Sentry.captureException(error);
  });
}

export function sanitizeWebSentryEvent<T extends Sentry.Event>(event: T, config: WebSentryConfig): T {
  event.tags = {
    ...event.tags,
    "first_tree.surface": "web",
    "first_tree.git_sha": config.buildId,
  };
  event.request = sanitizeRequest(event.request);
  if (event.transaction) event.transaction = sanitizeTransaction(event.transaction);
  event.breadcrumbs = undefined;
  event.contexts = scrubValue(event.contexts) as T["contexts"];
  event.extra = scrubValue(event.extra) as T["extra"];
  event.exception = scrubValue(event.exception) as T["exception"];
  if (event.message) event.message = sanitizeString(event.message);
  return event;
}

function sanitizeRequest(request: Sentry.Event["request"]): Sentry.Event["request"] {
  if (!request) return request;
  return {
    ...request,
    url: sanitizeUrl(request.url),
    headers: sanitizeHeaders(request.headers),
    cookies: undefined,
    query_string: undefined,
    data: undefined,
  };
}

type SentryRequest = NonNullable<Sentry.Event["request"]>;

function sanitizeHeaders(headers: SentryRequest["headers"]): SentryRequest["headers"] {
  if (!headers || typeof headers !== "object") return headers;
  const safeHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "cookie" || lower === "set-cookie" || SENSITIVE_KEY_RE.test(key)) {
      safeHeaders[key] = "[REDACTED]";
      continue;
    }
    safeHeaders[key] = sanitizeString(typeof value === "string" ? value : String(value));
  }
  return safeHeaders;
}

function scrubObject(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : scrubValue(item);
  }
  return out;
}

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item));
  return scrubObject(value as Record<string, unknown>);
}

function sanitizeUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${sanitizePath(parsed.pathname)}`;
  } catch {
    return sanitizePath(stripUrlSuffix(url));
  }
}

function sanitizeTransaction(transaction: string): string {
  try {
    const parsed = new URL(transaction, "https://first-tree.invalid");
    return sanitizePath(parsed.pathname);
  } catch {
    return sanitizePath(stripUrlSuffix(transaction));
  }
}

function sanitizeString(value: string): string {
  return value
    .replace(ABSOLUTE_URL_TEXT_RE, (match) => sanitizeUrl(match) ?? match)
    .replace(ROUTE_TEXT_RE, (match) => sanitizePath(stripUrlSuffix(match)))
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /(access_token|refresh_token|access|refresh|token|api_key|apiKey|secret|password|oauth_code|code)=([^&\s]+)/gi,
      `$1=${REDACTED}`,
    );
}

function stripUrlSuffix(url: string): string {
  const queryIndex = url.indexOf("?");
  const hashIndex = url.indexOf("#");
  const cutIndex = queryIndex === -1 ? hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
  return cutIndex === -1 ? url : url.slice(0, cutIndex);
}

function defaultEnvironment(): string {
  if (typeof window === "undefined") return import.meta.env.MODE || "development";
  return window.location.hostname === PROD_HOST ? "production" : import.meta.env.MODE || "development";
}

function parseSampleRate(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}
