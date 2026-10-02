import type { SystemOneRequest, SystemOneResponse } from "./index.js";
import { JevProxyClient } from "./proxy-client.js";
import { JuliaClient } from "./julia-client.js";

export type DecisionProvider = "julia" | "jev";

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
  { id: "julia", label: "Julia 1 · local CPU", description: "Default decision model through the local CPU service." },
  { id: "jev", label: "Jev · hosted", description: "Hosted decision model through the server-side proxy." },
] as const;

export interface DecisionClientOptions {
  jevEndpoint?: string;
  jevModel?: string;
  juliaEndpoint?: string;
  fetchImpl?: typeof fetch;
}

/** Explicit selection only: runtime failures never silently switch provider. */
export function createDecisionClient(provider: DecisionProvider = "julia", options: DecisionClientOptions = {}): DecisionClient {
  if (provider === "julia") return new JuliaClient({ endpoint: options.juliaEndpoint, fetchImpl: options.fetchImpl });
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
