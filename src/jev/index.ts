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

    return (await response.json()) as SystemOneResponse;
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
