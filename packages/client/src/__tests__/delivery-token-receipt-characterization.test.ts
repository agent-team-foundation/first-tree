/**
 * Characterization for Handler protocol dual-track (optional DeliveryToken +
 * string|receipt Start/Resume results) and HandlerConfig.runtimeProvider optionality.
 *
 * Detects live source so the same file:
 * - PASSes on PR base (documents dual-track + optional runtimeProvider)
 * - PASSes on this branch after receipts/tokens are required and runtimeProvider is required
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const handlerSourcePath = join(here, "..", "runtime", "handler.ts");
const claudeHandlerPath = join(here, "..", "handlers", "claude-code.ts");

type ProtocolShape = {
  startResultAllowsString: boolean;
  resumeResultAllowsString: boolean;
  startTokenOptional: boolean;
  injectTokenOptional: boolean;
  handlerConfigRuntimeProviderOptional: boolean;
  claudeHasExplicitDeliveryTokenShim: boolean;
};

function detectProtocolShape(): ProtocolShape {
  const handlerSrc = readFileSync(handlerSourcePath, "utf8");
  const claudeSrc = readFileSync(claudeHandlerPath, "utf8");

  const startResultAllowsString = /export type StartResult = StartReceipt\s*\|\s*string/.test(handlerSrc);
  const resumeResultAllowsString = /export type ResumeResult = ResumeReceipt\s*\|\s*string/.test(handlerSrc);
  const startTokenOptional = /start\(message: SessionMessage, ctx: SessionContext, token\?: DeliveryToken\)/.test(
    handlerSrc,
  );
  const injectTokenOptional = /inject\(message: SessionMessage, token\?: DeliveryToken\)/.test(handlerSrc);
  const handlerConfigRuntimeProviderOptional = /runtimeProvider\?: RuntimeProvider/.test(handlerSrc);
  const claudeHasExplicitDeliveryTokenShim = /hasExplicitDeliveryToken/.test(claudeSrc);

  return {
    startResultAllowsString,
    resumeResultAllowsString,
    startTokenOptional,
    injectTokenOptional,
    handlerConfigRuntimeProviderOptional,
    claudeHasExplicitDeliveryTokenShim,
  };
}

describe("delivery-token / receipt protocol characterization", () => {
  it("detects either legacy dual-track or tightened required receipts+token", () => {
    const shape = detectProtocolShape();
    const legacyDualTrack =
      shape.startResultAllowsString &&
      shape.resumeResultAllowsString &&
      shape.startTokenOptional &&
      shape.injectTokenOptional &&
      shape.handlerConfigRuntimeProviderOptional &&
      shape.claudeHasExplicitDeliveryTokenShim;

    const tightened =
      !shape.startResultAllowsString &&
      !shape.resumeResultAllowsString &&
      !shape.startTokenOptional &&
      !shape.injectTokenOptional &&
      !shape.handlerConfigRuntimeProviderOptional &&
      !shape.claudeHasExplicitDeliveryTokenShim;

    expect(legacyDualTrack || tightened).toBe(true);
  });

  it("StartResult / ResumeResult are either string|receipt (legacy) or receipt-only", () => {
    const shape = detectProtocolShape();
    if (shape.startResultAllowsString || shape.resumeResultAllowsString) {
      expect(shape.startResultAllowsString).toBe(true);
      expect(shape.resumeResultAllowsString).toBe(true);
    } else {
      const handlerSrc = readFileSync(handlerSourcePath, "utf8");
      expect(handlerSrc).toMatch(/export type StartResult = StartReceipt;/);
      expect(handlerSrc).toMatch(/export type ResumeResult = ResumeReceipt;/);
    }
  });

  it("messageful DeliveryToken is either optional (legacy) or required on start/inject", () => {
    const shape = detectProtocolShape();
    if (shape.startTokenOptional || shape.injectTokenOptional) {
      expect(shape.startTokenOptional).toBe(true);
      expect(shape.injectTokenOptional).toBe(true);
    } else {
      const handlerSrc = readFileSync(handlerSourcePath, "utf8");
      expect(handlerSrc).toMatch(/start\(message: SessionMessage, ctx: SessionContext, token: DeliveryToken\)/);
      expect(handlerSrc).toMatch(/inject\(message: SessionMessage, token: DeliveryToken\)/);
    }
  });

  it("HandlerConfig.runtimeProvider is either optional (legacy) or required", () => {
    const shape = detectProtocolShape();
    if (shape.handlerConfigRuntimeProviderOptional) {
      expect(shape.handlerConfigRuntimeProviderOptional).toBe(true);
    } else {
      const handlerSrc = readFileSync(handlerSourcePath, "utf8");
      expect(handlerSrc).toMatch(/runtimeProvider: RuntimeProvider;/);
      expect(handlerSrc).not.toMatch(/runtimeProvider\?: RuntimeProvider/);
    }
  });

  it("claude-code either keeps hasExplicitDeliveryToken shim or returns receipts only", () => {
    const shape = detectProtocolShape();
    const claudeSrc = readFileSync(claudeHandlerPath, "utf8");
    if (shape.claudeHasExplicitDeliveryTokenShim) {
      expect(claudeSrc).toContain("hasExplicitDeliveryToken");
    } else {
      expect(claudeSrc).not.toContain("hasExplicitDeliveryToken");
      expect(claudeSrc).toMatch(/route:\s*\{\s*kind:\s*"owned"/);
    }
  });
});
