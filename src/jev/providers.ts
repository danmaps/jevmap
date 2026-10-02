import type { SystemOneRequest, SystemOneResponse, ChoiceAnswer } from "./index.js";
import { JevProxyClient } from "./proxy-client.js";
import { JuliaClient } from "./julia-client.js";

export type DecisionProvider = "jev" | "julia" | "demo";

export interface DecisionProvenance {
  backend: DecisionProvider;
  runtime: "remote" | "python-cpu" | "simulated";
  model: string;
  version: string;
  simulated: boolean;
}

export interface DecisionClient {
  readonly model?: string;
  ask(state: SystemOneRequest["state"], questions: SystemOneRequest["questions"]): Promise<SystemOneResponse>;
}

export const DECISION_PROVIDERS = [
  { id: "jev", label: "Jev · hosted", description: "Default decision model through the server-side proxy." },
  { id: "julia", label: "Julia 1 · local CPU", description: "Real Julia checkpoint through the optional local Python service." },
  { id: "demo", label: "Demo · simulated", description: "Offline deterministic demonstration; no model inference." },
] as const;

export interface DecisionClientOptions {
  jevEndpoint?: string;
  jevModel?: string;
  juliaEndpoint?: string;
  fetchImpl?: typeof fetch;
}

/** Explicit selection only: runtime failures never silently switch provider. */
export function createDecisionClient(provider: DecisionProvider = "jev", options: DecisionClientOptions = {}): DecisionClient {
  if (provider === "julia") return new JuliaClient({ endpoint: options.juliaEndpoint, fetchImpl: options.fetchImpl });
  if (provider === "demo") return new DemoDecisionClient();
  if (provider !== "jev") throw new Error(`Unknown decision provider: ${String(provider)}`);
  const client = new JevProxyClient({ endpoint: options.jevEndpoint, model: options.jevModel ?? "jev-latest", fetchImpl: options.fetchImpl });
  return {
    model: options.jevModel ?? "jev-latest",
    async ask(state, questions) {
      const response = await client.ask(state, questions);
      return {
        ...response,
        provenance: { backend: "jev", runtime: "remote", model: response.model, version: response.model, simulated: false },
      };
    },
  };
}

/** A transparent, deterministic demo router, never presented as Julia or Jev. */
export class DemoDecisionClient implements DecisionClient {
  public readonly model = "demo-rules-v1";
  public async ask(state: SystemOneRequest["state"], questions: SystemOneRequest["questions"]): Promise<SystemOneResponse> {
    const intent = typeof state === "string" ? state : !Array.isArray(state) && typeof state.intent === "string" ? state.intent : JSON.stringify(state);
    const answers: Record<string, ChoiceAnswer> = {};
    for (const [name, question] of Object.entries(questions)) {
      if (question.type !== "choice") throw new Error("Demo mode supports bounded choice questions only.");
      const keys = Object.keys(question.criteria);
      if (keys.length < 1 || keys.length > 20) throw new Error("Demo mode requires 1–20 legal candidates.");
      const scores = keys.map((key) => demoScore(intent, key, question.criteria[key]));
      const best = Math.max(...scores);
      const winners = keys.filter((_, index) => scores[index] === best);
      const selected = winners[0]!;
      const confidence = keys.length === 1 ? 1 : best > 0 && winners.length === 1 ? 0.9 : 1 / keys.length;
      const probabilities = Object.fromEntries(keys.map((key) => [key, key === selected ? confidence : (1 - confidence) / (keys.length - 1)]));
      answers[name] = { type: "choice", choice: selected, confidence, probabilities };
    }
    return {
      model: "demo-rules-v1",
      provenance: { backend: "demo", runtime: "simulated", model: "demo-rules-v1", version: "1", simulated: true },
      answers,
      usageReported: false,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
}

function demoScore(intent: string, id: string, description: unknown): number {
  const normalized = intent.toLowerCase();
  const escapedId = id.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\b${escapedId}\\b`).test(normalized)) return 100;
  const distance = normalized.match(/\b(\d+(?:\.\d+)?)\s*(kilometers?|kilometres?|km|meters?|metres?|m)\b/);
  const candidateDistance = id.match(/^(\d+(?:\.\d+)?)(km|m)$/);
  if (distance && candidateDistance) {
    const meters = Number(distance[1]) * (distance[2]!.startsWith("k") ? 1000 : 1);
    const candidateMeters = Number(candidateDistance[1]) * (candidateDistance[2] === "km" ? 1000 : 1);
    return meters === candidateMeters ? 100 : 0;
  }
  const words = `${id.replace(/[-_]/g, " ")} ${typeof description === "string" ? description : JSON.stringify(description)}`.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const ignored = new Set(["from", "with", "this", "that", "features", "layer", "geometry", "input", "use", "available", "deterministic"]);
  return [...new Set(words)].filter((word) => !ignored.has(word) && normalized.includes(word)).length;
}
