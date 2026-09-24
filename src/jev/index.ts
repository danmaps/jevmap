export interface ChoiceQuestion {
  type: "choice";
  instructions?: string | Record<string, unknown> | unknown[] | null;
  criteria: Record<string, unknown>;
}

export interface NoulQuestion {
  type: "noul";
  instructions?: string | Record<string, unknown> | unknown[] | null;
  criteria?: {
    true?: unknown;
    false?: unknown;
  } | null;
}

export interface ScoreQuestion {
  type: "score";
  instructions?: string | Record<string, unknown> | unknown[] | null;
  criteria: unknown[];
}

export type JevQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export interface SystemOneRequest {
  state: string | Record<string, unknown> | unknown[];
  model: string;
  questions: Record<string, JevQuestion>;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  legend: Record<string, unknown>;
  probabilities: Record<string, number>;
}

export type JevAnswer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export interface SystemOneResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSystemOneResponse(value: unknown): SystemOneResponse {
  if (!isRecord(value) || typeof value.model !== "string" || !isRecord(value.answers)) {
    throw new Error("TypeSafe returned a malformed System One response.");
  }

  const rawUsage = isRecord(value.usage) ? value.usage : {};
  const inputTokens = rawUsage.input_tokens;
  const outputTokens = rawUsage.output_tokens;

  return {
    model: value.model,
    answers: value.answers as Record<string, JevAnswer>,
    usage: {
      input_tokens: typeof inputTokens === "number" ? inputTokens : 0,
      output_tokens: typeof outputTokens === "number" ? outputTokens : 0,
    },
  };
}

export function parseChoiceAnswer(
  value: unknown,
  questionName: string,
  criteria: Readonly<Record<string, unknown>>,
): ChoiceAnswer {
  if (!isRecord(value) || value.type !== "choice") {
    throw new Error(`TypeSafe did not return a choice answer for "${questionName}".`);
  }
  if (typeof value.choice !== "string" || !Object.hasOwn(criteria, value.choice)) {
    throw new Error(`TypeSafe returned an unavailable choice for "${questionName}".`);
  }
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    throw new Error(`TypeSafe returned invalid confidence for "${questionName}".`);
  }
  if (!isRecord(value.probabilities)) {
    throw new Error(`TypeSafe returned invalid probabilities for "${questionName}".`);
  }

  const probabilities: Record<string, number> = {};
  for (const [key, probability] of Object.entries(value.probabilities)) {
    if (!Object.hasOwn(criteria, key)) {
      throw new Error(`TypeSafe returned an unknown probability candidate for "${questionName}".`);
    }
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error(`TypeSafe returned an invalid probability for "${questionName}".`);
    }
    probabilities[key] = probability;
  }

  return {
    type: "choice",
    choice: value.choice,
    confidence: value.confidence,
    probabilities,
  };
}

export interface TypeSafeClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class TypeSafeClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: TypeSafeClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "jev-latest";
    this.baseUrl = (options.baseUrl ?? "https://api.typesafe.ai").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async ask(
    state: SystemOneRequest["state"],
    questions: SystemOneRequest["questions"],
  ): Promise<SystemOneResponse> {
    const request: SystemOneRequest = {
      state,
      model: this.model,
      questions,
    };

    const response = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`TypeSafe request failed: ${response.status} ${response.statusText}`);
    }

    return parseSystemOneResponse(await response.json());
  }
}

export function choiceQuestion(
  instructions: string,
  criteria: Record<string, unknown>,
): ChoiceQuestion {
  if (Object.keys(criteria).length === 0) {
    throw new Error("A choice question requires at least one criterion.");
  }

  return {
    type: "choice",
    instructions,
    criteria,
  };
}

export type DecisionPolicyResult = "execute" | "review" | "clarify";

export interface DecisionPolicy {
  executeAt: number;
  reviewAt: number;
}

export const DEFAULT_DECISION_POLICY: DecisionPolicy = {
  executeAt: 0.8,
  reviewAt: 0.55,
};

export function applyDecisionPolicy(
  confidence: number,
  policy: DecisionPolicy = DEFAULT_DECISION_POLICY,
): DecisionPolicyResult {
  if (confidence >= policy.executeAt) return "execute";
  if (confidence >= policy.reviewAt) return "review";
  return "clarify";
}
