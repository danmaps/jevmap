import type { DecisionClient } from "../analysis/index.js";
import type { SystemOneRequest, SystemOneResponse } from "./index.js";
import { parseSystemOneResponse } from "./index.js";

export interface JevProxyClientOptions {
  endpoint?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export class JevProxyClient implements DecisionClient {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: JevProxyClientOptions = {}) {
    this.endpoint = options.endpoint ?? "/api/jev";
    this.model = options.model ?? "jev-latest";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async ask(
    state: SystemOneRequest["state"],
    questions: SystemOneRequest["questions"],
  ): Promise<SystemOneResponse> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, model: this.model, questions }),
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error(
        "The live Jev proxy is not connected yet. Add the /api/jev Caddy route and start jevmap.service.",
      );
    }

    const payload: unknown = await response.json();
    if (!response.ok) {
      const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : `Jev request failed (${response.status}).`;
      throw new Error(message);
    }

    return parseSystemOneResponse(payload);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
