export type GateExitBatch = {
  failed: number;
};

export type IncludedQualityExitResult = {
  batch: GateExitBatch | null;
  skippedReason: string | null;
};

export function gateCommandFailed(gate: GateExitBatch, quality: IncludedQualityExitResult | null): boolean {
  if (gate.failed > 0) return true;
  if (quality === null) return false;
  return (quality.batch?.failed ?? 0) > 0 || quality.skippedReason !== null;
}
