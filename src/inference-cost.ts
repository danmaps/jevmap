// USD per million tokens, verified against provider pricing on 2026-09-24.
// Standard, uncached, short-context requests; no batch or reasoning surcharge estimate.
export const INFERENCE_RATES = [
  { name: "Jev", input: 0.042, output: 0, source: "https://typesafe.ai/blog/introducing-system-one-models-and-jev" },
  { name: "Julia 1 · local CPU", input: 0, output: 0, source: "https://huggingface.co/SupersonicLabs/Julia-1" },
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

export function summarizeProviderInference(plan: { model: string; provenance?: { backend: string }; inference: { inputTokens?: number; outputTokens?: number } } | undefined, selectedProvider: "jev" | "julia") {
  const isJev = plan ? (plan.provenance?.backend ? plan.provenance.backend === "jev" : /^jev(?:-|$)/i.test(plan.model)) : selectedProvider === "jev";
  const providerName = isJev ? "Jev" : "Julia 1 · local CPU";
  const rate = INFERENCE_RATES.find((item) => item.name === providerName)!;
  const inputTokens = plan ? plan.inference.inputTokens : 2000;
  const cost = isJev ? (inputTokens === undefined ? undefined : estimateInferenceCost(inputTokens, plan?.inference.outputTokens ?? 0, rate)) : 0;
  return { isJev, providerName, inputTokens, cost };
}
