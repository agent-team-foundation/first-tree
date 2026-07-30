import type { ContextIntegrationProvider } from "@first-tree/shared";
import { Terminal } from "lucide-react";
import { useState } from "react";
import { generateConnectToken } from "../../api/activity.js";
import { getContextEnablementHandoff } from "../../api/context-enablement.js";
import { ByoSetupPromptActions } from "../../components/byo-setup-prompt-actions.js";
import { Button } from "../../components/ui/button.js";
import { buildByoSetupPrompt } from "../../lib/byo-setup-prompt.js";

const PROVIDERS: Array<{ id: ContextIntegrationProvider; label: string }> = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

export function OnboardingContextPersonalAccess({ organizationId, ready }: { organizationId: string; ready: boolean }) {
  const [provider, setProvider] = useState<ContextIntegrationProvider>("claude-code");

  if (!ready) return null;

  return (
    <section
      id="context-access"
      aria-labelledby="context-access-title"
      style={{
        margin: "var(--sp-5)",
        padding: "var(--sp-5)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-panel)",
      }}
    >
      <div className="flex items-start" style={{ gap: "var(--sp-3)" }}>
        <Terminal className="h-4 w-4 shrink-0" aria-hidden style={{ marginTop: "var(--sp-1)", color: "var(--fg-3)" }} />
        <div className="min-w-0 flex-1">
          <h2 id="context-access-title" className="text-body font-medium" style={{ margin: 0 }}>
            Use Team Context in your coding agent
          </h2>
          <p className="text-caption" style={{ margin: "var(--sp-1) 0 0", color: "var(--fg-3)" }}>
            Optional · Copy one setup prompt into Claude Code or Codex. That conversation stays outside First Tree Chat.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap" style={{ gap: "var(--sp-2)", marginTop: "var(--sp-4)" }}>
        {PROVIDERS.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant={provider === item.id ? "default" : "outline"}
            size="sm"
            aria-pressed={provider === item.id}
            onClick={() => setProvider(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </div>

      <div style={{ marginTop: "var(--sp-3)" }}>
        <ByoSetupPromptActions
          preparePrompt={() => prepareOnboardingByoSetupPrompt(organizationId, provider)}
          resetKey={`${organizationId}:${provider}:${ready}`}
        />
      </div>
    </section>
  );
}

export async function prepareOnboardingByoSetupPrompt(
  organizationId: string,
  provider: ContextIntegrationProvider,
): Promise<string> {
  const [bootstrap, handoff] = await Promise.all([
    generateConnectToken(),
    getContextEnablementHandoff(organizationId, provider),
  ]);
  if (handoff.provider !== provider) {
    throw new Error("BYO setup handoff does not match the selected provider");
  }
  return buildByoSetupPrompt({
    organizationId,
    bootstrapCommand: bootstrap.bootstrapCommand,
    handoffs: [handoff],
    intent: "onboarding",
  });
}

export async function prepareSettingsByoSetupPrompt(organizationId: string): Promise<string> {
  const [bootstrap, claudeHandoff, codexHandoff] = await Promise.all([
    generateConnectToken(),
    getContextEnablementHandoff(organizationId, "claude-code"),
    getContextEnablementHandoff(organizationId, "codex"),
  ]);
  return buildByoSetupPrompt({
    organizationId,
    bootstrapCommand: bootstrap.bootstrapCommand,
    handoffs: [claudeHandoff, codexHandoff],
    intent: "settings",
  });
}

export function ContextPersonalAccess({
  organizationId,
  preparePrompt = prepareSettingsByoSetupPrompt,
}: {
  organizationId: string;
  preparePrompt?: (organizationId: string) => Promise<string>;
}) {
  return (
    <div
      data-setup-personal-access
      className="flex flex-wrap items-center justify-between"
      style={{ gap: "var(--sp-3)" }}
    >
      <div className="min-w-0" style={{ flex: "1 1 28rem" }}>
        <div className="text-body font-medium" style={{ color: "var(--fg)" }}>
          Use with Claude Code or Codex
        </div>
        <div className="text-label" style={{ marginTop: "var(--sp-0_5)", color: "var(--fg-3)" }}>
          Open your project in Claude Code or Codex, then copy and paste the setup prompt.
        </div>
      </div>
      <ByoSetupPromptActions
        align="end"
        preparePrompt={() => preparePrompt(organizationId)}
        resetKey={organizationId}
      />
    </div>
  );
}
