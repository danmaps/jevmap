// USD per million tokens, verified against provider pricing on 2026-09-24.
// Standard, uncached, short-context requests; no batch or reasoning surcharge estimate.
export const INFERENCE_RATES = [
  { name: "Jev", input: 0.042, output: 0, source: "https://typesafe.ai/blog/introducing-system-one-models-and-jev" },
  { name: "GPT-6 Luna", input: 0.10, output: 0.50, source: "https://developers.openai.com/api/docs/models/gpt-6-luna" },
  { name: "Claude Sonnet 5", input: 2, output: 10, source: "https://platform.claude.com/docs/en/about-claude/pricing" },
] as const;

export function estimateInferenceCost(inputTokens: number, outputTokens: number, rate: { input: number; output: number }): number | undefined {
  if (![inputTokens, outputTokens].every(value => Number.isInteger(value) && value >= 0)) return undefined;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

export function formatCost(cost: number | undefined): string {
  if (cost === undefined) return "Unavailable";
  if (cost > 0 && cost < 0.000001) return "<$0.000001";
  return `$${cost.toFixed(6)}`;
}
