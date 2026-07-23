import type {
  BrowserSecurityActivation,
  BrowserSecurityIntegration,
  BrowserSecurityManifest,
  BrowserSecuritySources,
} from "@first-tree/shared";

export const PRODUCTION_WEB_HOST = "cloud.first-tree.ai";

export const GOOGLE_ANALYTICS_INTEGRATION_ID = "google-analytics";
export const MICROSOFT_CLARITY_INTEGRATION_ID = "microsoft-clarity";
export const WEB_SENTRY_INTEGRATION_ID = "web-sentry";

export const GOOGLE_ANALYTICS_MEASUREMENT_ID = "G-BHG918MZ02";
export const GOOGLE_ANALYTICS_LOADER_URL = `https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ANALYTICS_MEASUREMENT_ID}`;
export const MICROSOFT_CLARITY_PROJECT_ID = "xj2f9syfng";
export const MICROSOFT_CLARITY_LOADER_URL = `https://www.clarity.ms/tag/${MICROSOFT_CLARITY_PROJECT_ID}`;

export const CLARITY_COLLECTOR_ORIGINS = Array.from(
  { length: 26 },
  (_, index) => `https://${String.fromCharCode("a".charCodeAt(0) + index)}.clarity.ms`,
);

export type BrowserResourceCapability = "script" | "connect" | "image";
export type BrowserResourceRequirement = "required" | "conditional";
export type BrowserResourceType = "script" | "fetch-or-beacon" | "image";

export type BrowserResourcePolicyRow = {
  requirement: BrowserResourceRequirement;
  capability: BrowserResourceCapability;
  origin: string;
  initiator: string;
  resourceType: BrowserResourceType;
};

export type BrowserDynamicResourcePolicyRow = Omit<BrowserResourcePolicyRow, "origin"> & {
  originFrom: "sentry-dsn";
};

type BrowserHostActivation = {
  kind: "hosts";
  hosts: readonly string[];
};

type BrowserBuildActivation = {
  kind: "sentry-build";
};

type BrowserConditionalActivation = {
  kind: "conditional-environment";
};

export type BrowserIntegrationPolicy = {
  id: string;
  activation: BrowserHostActivation | BrowserBuildActivation | BrowserConditionalActivation;
  loaderUrl?: string;
  rows: readonly BrowserResourcePolicyRow[];
  dynamicRows?: readonly BrowserDynamicResourcePolicyRow[];
};

function policyRow(
  requirement: BrowserResourceRequirement,
  capability: BrowserResourceCapability,
  origin: string,
  initiator: string,
  resourceType: BrowserResourceType,
): BrowserResourcePolicyRow {
  return { requirement, capability, origin, initiator, resourceType };
}

const googleAnalyticsRows = [
  policyRow("required", "script", "https://www.googletagmanager.com", "First Tree analytics bootstrap", "script"),
  policyRow(
    "required",
    "connect",
    "https://analytics.google.com",
    "Google Analytics gtag.js transport",
    "fetch-or-beacon",
  ),
  policyRow(
    "required",
    "connect",
    "https://region1.google-analytics.com",
    "Google Analytics gtag.js regional transport",
    "fetch-or-beacon",
  ),
  policyRow(
    "required",
    "connect",
    "https://www.google-analytics.com",
    "Google Analytics gtag.js transport",
    "fetch-or-beacon",
  ),
  policyRow(
    "required",
    "connect",
    "https://www.googletagmanager.com",
    "Google Analytics gtag.js transport",
    "fetch-or-beacon",
  ),
  policyRow(
    "required",
    "image",
    "https://region1.google-analytics.com",
    "Google Analytics gtag.js regional fallback",
    "image",
  ),
  policyRow("required", "image", "https://www.google-analytics.com", "Google Analytics gtag.js fallback", "image"),
  policyRow("required", "image", "https://www.googletagmanager.com", "Google Analytics gtag.js fallback", "image"),
] as const;

const microsoftClarityRows = [
  policyRow(
    "required",
    "script",
    "https://www.clarity.ms",
    "First Tree analytics bootstrap and Clarity loader",
    "script",
  ),
  ...CLARITY_COLLECTOR_ORIGINS.map((origin) =>
    policyRow("required", "connect", origin, "Microsoft Clarity SDK collector", "fetch-or-beacon"),
  ),
  policyRow("required", "image", "https://c.bing.com", "Microsoft Clarity SDK sync pixel", "image"),
  policyRow("required", "image", "https://c.clarity.ms", "Microsoft Clarity SDK sync pixel", "image"),
] as const;

/**
 * Browser-visible dependencies and their directive-specific evidence. Required
 * rows become build-manifest requirements. Conditional rows are inventory only
 * until the exact candidate environment makes the dependency real.
 */
export const BROWSER_INTEGRATION_REGISTRY = {
  googleAnalytics: {
    id: GOOGLE_ANALYTICS_INTEGRATION_ID,
    activation: { kind: "hosts", hosts: [PRODUCTION_WEB_HOST] },
    loaderUrl: GOOGLE_ANALYTICS_LOADER_URL,
    rows: googleAnalyticsRows,
  },
  microsoftClarity: {
    id: MICROSOFT_CLARITY_INTEGRATION_ID,
    activation: { kind: "hosts", hosts: [PRODUCTION_WEB_HOST] },
    loaderUrl: MICROSOFT_CLARITY_LOADER_URL,
    rows: microsoftClarityRows,
  },
  webSentry: {
    id: WEB_SENTRY_INTEGRATION_ID,
    activation: { kind: "sentry-build" },
    rows: [],
    dynamicRows: [
      {
        requirement: "required",
        capability: "connect",
        originFrom: "sentry-dsn",
        initiator: "@sentry/react browser transport",
        resourceType: "fetch-or-beacon",
      },
    ],
  },
  githubAvatar: {
    id: "github-avatar",
    activation: { kind: "conditional-environment" },
    rows: [
      policyRow(
        "conditional",
        "image",
        "https://avatars.githubusercontent.com",
        "OAuth profile avatar element",
        "image",
      ),
    ],
  },
  googleAvatar: {
    id: "google-avatar",
    activation: { kind: "conditional-environment" },
    rows: [
      policyRow("conditional", "image", "https://lh3.googleusercontent.com", "OIDC profile avatar element", "image"),
    ],
  },
  cloudflareBrowserInsights: {
    id: "cloudflare-browser-insights",
    activation: { kind: "conditional-environment" },
    rows: [
      policyRow(
        "conditional",
        "script",
        "https://static.cloudflareinsights.com",
        "Cloudflare edge-injected Browser Insights bootstrap",
        "script",
      ),
    ],
  },
} as const satisfies Record<string, BrowserIntegrationPolicy>;

export type SentryBuildEnvironment = {
  VITE_SENTRY_DSN?: string;
  VITE_SENTRY_ENABLED?: string;
};

export type EffectiveSentryIntegration =
  | { active: false }
  | {
      active: true;
      dsn: string;
      origin: string;
    };

const FALSE_ENV_VALUES = new Set(["0", "false", "off", "no"]);

/** Resolve the one effective Sentry activation used by both Web and Vite. */
export function resolveEffectiveSentryIntegration(env: SentryBuildEnvironment): EffectiveSentryIntegration {
  const dsn = env.VITE_SENTRY_DSN?.trim();
  const rawEnabled = env.VITE_SENTRY_ENABLED?.trim().toLowerCase();
  const enabled = rawEnabled ? !FALSE_ENV_VALUES.has(rawEnabled) : Boolean(dsn);
  if (!enabled || !dsn) return { active: false };

  try {
    const parsed = new URL(dsn);
    const projectId = parsed.pathname.split("/").filter(Boolean).at(-1);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username.length === 0 ||
      parsed.password.length > 0 ||
      !projectId
    ) {
      throw new Error("invalid Sentry DSN shape");
    }
    return { active: true, dsn, origin: parsed.origin };
  } catch {
    // Never include the value: a DSN contains project routing material.
    throw new Error("VITE_SENTRY_DSN must be a valid HTTP(S) Sentry DSN");
  }
}

/**
 * Reproduce Vite's environment precedence for the VITE_ namespace: values
 * already present in the process win over mode-specific env-file values.
 */
export function resolveViteBrowserEnvironment(
  fileEnvironment: Readonly<Record<string, string>>,
  processEnvironment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const resolved = { ...fileEnvironment };
  for (const [key, value] of Object.entries(processEnvironment)) {
    if (key.startsWith("VITE_") && typeof value === "string") resolved[key] = value;
  }
  return resolved;
}

export function isBrowserIntegrationActive(integration: BrowserIntegrationPolicy, hostname: string): boolean {
  return integration.activation.kind === "hosts" && integration.activation.hosts.includes(hostname.toLowerCase());
}

type BrowserDynamicOriginValues = Partial<Record<BrowserDynamicResourcePolicyRow["originFrom"], string>>;

/**
 * Materialize one registry entry into its required CSP sources. Loader URLs
 * stay coupled to the directive matrix, while dynamic requirements take their
 * capability from the registry row instead of integration-specific code.
 */
export function materializeBrowserSecuritySources(
  integration: BrowserIntegrationPolicy,
  dynamicOrigins: Readonly<BrowserDynamicOriginValues> = {},
): BrowserSecuritySources {
  const sourceSets: Record<BrowserResourceCapability, Set<string>> = {
    script: new Set(),
    connect: new Set(),
    image: new Set(),
  };
  for (const row of integration.rows) {
    if (row.requirement === "required") sourceSets[row.capability].add(row.origin);
  }

  for (const row of integration.dynamicRows ?? []) {
    if (row.requirement !== "required") continue;
    const origin = dynamicOrigins[row.originFrom];
    if (!origin) {
      throw new Error(`Browser integration ${integration.id} is missing a required dynamic origin`);
    }
    sourceSets[row.capability].add(origin);
  }

  if (integration.loaderUrl) {
    let loaderOrigin: string;
    try {
      loaderOrigin = new URL(integration.loaderUrl).origin;
    } catch {
      throw new Error(`Browser integration ${integration.id} has an invalid loader URL`);
    }
    if (!sourceSets.script.has(loaderOrigin)) {
      throw new Error(`Browser integration ${integration.id} must declare its loader origin as a required script`);
    }
  }

  return {
    script: [...sourceSets.script].sort(),
    connect: [...sourceSets.connect].sort(),
    image: [...sourceSets.image].sort(),
  };
}

function manifestActivation(integration: BrowserIntegrationPolicy): BrowserSecurityActivation | null {
  if (integration.activation.kind === "hosts") {
    return { hosts: [...integration.activation.hosts].sort() };
  }
  return null;
}

function staticManifestIntegration(integration: BrowserIntegrationPolicy): BrowserSecurityIntegration | null {
  const activation = manifestActivation(integration);
  if (!activation) return null;
  return {
    id: integration.id,
    activation,
    required: materializeBrowserSecuritySources(integration),
  };
}

export function buildBrowserSecurityManifest(buildId: string, env: SentryBuildEnvironment): BrowserSecurityManifest {
  const staticIntegrations: BrowserSecurityIntegration[] = [];
  for (const integration of Object.values(BROWSER_INTEGRATION_REGISTRY)) {
    const manifestIntegration = staticManifestIntegration(integration);
    if (manifestIntegration) staticIntegrations.push(manifestIntegration);
  }

  const sentry = resolveEffectiveSentryIntegration(env);
  if (sentry.active) {
    staticIntegrations.push({
      id: BROWSER_INTEGRATION_REGISTRY.webSentry.id,
      activation: { allHosts: true },
      required: materializeBrowserSecuritySources(BROWSER_INTEGRATION_REGISTRY.webSentry, {
        "sentry-dsn": sentry.origin,
      }),
    });
  }

  staticIntegrations.sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: 1,
    buildId,
    integrations: staticIntegrations,
  };
}
