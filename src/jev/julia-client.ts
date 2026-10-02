import { parseChoiceAnswer, type ChoiceAnswer, type ChoiceQuestion, type SystemOneRequest, type SystemOneResponse } from "./index.js";
import type { DecisionClient, DecisionProvenance } from "./providers.js";

export const JULIA_MODEL = "SupersonicLabs/Julia-1";
export const JULIA_REVISION = "a85b127321d580d65176c89ced8273f305745d85";
export const JULIA_MIN_CANDIDATES = 2;
export const JULIA_MAX_CANDIDATES = 20;

export interface JuliaClientOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Native named-question API adapter; GIS execution stays in the Workbench. */
export class JuliaClient implements DecisionClient {
  public readonly model = JULIA_MODEL;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(options: JuliaClientOptions = {}) {
    this.endpoint = options.endpoint ?? "http://127.0.0.1:8765/api/julia";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  public async ask(state: SystemOneRequest["state"], questions: SystemOneRequest["questions"]): Promise<SystemOneResponse> {
    const nativeQuestions: Record<string, ChoiceQuestion> = {};
    const answers: Record<string, ChoiceAnswer> = {};
    if (Object.keys(questions).length < 1 || Object.keys(questions).length > 16) throw new Error("Julia requires 1–16 named questions per request.");
    for (const [name, question] of Object.entries(questions)) {
      if (question.type !== "choice") throw new Error("The Julia adapter supports bounded choice questions only.");
      const keys = Object.keys(question.criteria);
      if (keys.length === 0 || keys.length > JULIA_MAX_CANDIDATES) throw new Error(`Julia question "${name}" requires 1–20 candidates; native inference supports 2–20.`);
      const criteria = Object.fromEntries(Object.entries(question.criteria).map(([id, value]) => {
        const description = typeof value === "string" ? value : JSON.stringify(value);
        if (!id.trim() || !description?.trim()) throw new Error(`Julia question "${name}" requires named candidates with nonempty descriptions.`);
        return [id, description];
      }));
      if (keys.length === 1) {
        // A single legal candidate needs no model call and adds no invented alternatives.
        answers[name] = { type: "choice", choice: keys[0]!, confidence: 1, probabilities: { [keys[0]!]: 1 } };
      } else {
        nativeQuestions[name] = { type: "choice", instructions: typeof question.instructions === "string" ? question.instructions : JSON.stringify(question.instructions ?? ""), criteria };
      }
    }
    let provenance: DecisionProvenance = { backend: "julia", runtime: "python-cpu", model: JULIA_MODEL, version: JULIA_REVISION, simulated: false };
    if (Object.keys(nativeQuestions).length) {
      const body = JSON.stringify({ state, questions: nativeQuestions });
      if (new TextEncoder().encode(body).byteLength > 262_144) throw new Error("Julia request exceeds the 256 KiB state/question limit; reduce map summaries.");
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!(response.headers.get("content-type") ?? "").includes("application/json")) throw new Error("Julia service is unavailable. Start scripts/julia-service.py and check the Julia endpoint.");
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(isRecord(payload) && typeof payload.error === "string" ? payload.error : `Julia request failed (${response.status}).`);
      if (!isRecord(payload) || payload.model !== JULIA_MODEL || !isRecord(payload.answers)) throw new Error("Julia returned a malformed named-question response.");
      const expectedNames = Object.keys(nativeQuestions);
      if (Object.keys(payload.answers).length !== expectedNames.length || Object.keys(payload.answers).some((name) => !Object.hasOwn(nativeQuestions, name))) throw new Error("Julia returned unexpected or missing question names.");
      for (const [name, question] of Object.entries(nativeQuestions)) answers[name] = parseJuliaChoiceAnswer(payload.answers[name], name, question.criteria);
      const source = payload.provenance;
      if (!isRecord(source) || source.backend !== "julia" || source.runtime !== "python-cpu" || source.simulated !== false || source.model !== JULIA_MODEL || typeof source.version !== "string" || !source.version.trim()) throw new Error("Julia returned missing or invalid runtime provenance.");
      provenance = { backend: "julia", runtime: "python-cpu", simulated: false, model: JULIA_MODEL, version: source.version };
    }
    return { model: JULIA_MODEL, provenance, answers, usageReported: false, usage: { input_tokens: 0, output_tokens: 0 } };
  }
}

export function parseJuliaChoiceAnswer(value: unknown, name: string, criteria: Readonly<Record<string, unknown>>): ChoiceAnswer {
  if (!isRecord(value) || !isRecord(value.probabilities)) throw new Error(`Julia returned malformed probabilities for "${name}".`);
  const keys = Object.keys(criteria);
  const probabilities = value.probabilities;
  if (Object.keys(probabilities).length !== keys.length || keys.some((id) => !Object.hasOwn(probabilities, id))) throw new Error(`Julia returned missing or unknown candidates for "${name}".`);
  const parsed = parseChoiceAnswer({ ...value, confidence: value.max_probability }, name, criteria);
  const total = Object.values(parsed.probabilities).reduce((sum, probability) => sum + probability, 0);
  const max = Math.max(...Object.values(parsed.probabilities));
  if (Math.abs(total - 1) > 0.000_001 || Math.abs(parsed.confidence - max) > 0.000_001 || Math.abs(parsed.probabilities[parsed.choice]! - max) > 0.000_001) throw new Error(`Julia returned inconsistent probabilities for "${name}".`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
