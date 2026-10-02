import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createDecisionClient, type DecisionProvider } from "../src/jev/providers.js";
import { parseChoiceAnswer, type ChoiceQuestion } from "../src/jev/index.js";
import { parseDecisionSurface, OPERATION_POLICY, LAYER_POLICY, DISTANCE_POLICY, type DecisionField } from "../src/decisions/index.js";
import * as workflow from "../src/analysis/workflow.js";
import { summarizeFeatureCollection } from "../src/state/index.js";

interface Fixture {
  id: string;
  kind: string;
  state: Record<string, unknown>;
  question: ChoiceQuestion;
  expected?: string;
  expectedAbstention?: boolean;
  workflowGuard?: boolean;
}

export async function evaluateDecisions(args: string[]) {
  const arg = (name: string, fallback: string) => args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
  const fixturePath = arg("--fixtures", "tests/fixtures/decision-evaluation.json");
  const outputPath = arg("--output", "docs/evaluation/latest.json");
  const providers = arg("--providers", "julia,jev").split(",") as DecisionProvider[];
  const fixtureBytes = await readFile(fixturePath);
  const fixtureSet = JSON.parse(fixtureBytes.toString()) as { version: number; cases: Fixture[] };
  const runs = [];
  for (const provider of providers) {
    if (provider === "jev" && !process.env.JEV_EVALUATION_ENDPOINT) {
      runs.push({ provider, status: "not-run", reason: "No explicitly configured Jev proxy endpoint. No hosted model call was made.", metrics: null, cases: [] });
      continue;
    }
    const client = createDecisionClient(provider, { juliaEndpoint: process.env.JULIA_EVALUATION_ENDPOINT, jevEndpoint: process.env.JEV_EVALUATION_ENDPOINT });
    const cases: Array<Record<string, unknown>> = [];
    const timings: number[] = [];
    for (const fixture of fixtureSet.cases) {
      const started = performance.now();
      try {
        const result = await client.ask(fixture.state, { decision: fixture.question });
        const latencyMs = Math.round((performance.now() - started) * 100) / 100;
        timings.push(latencyMs);
        const answer = parseChoiceAnswer(result.answers.decision, "decision", fixture.question.criteria);
        const definition = fixtureField(fixture);
        const parsed = parseDecisionSurface({ state: fixture.state, fields: { decision: definition } }, result);
        const field = parsed.fields.decision;
        if (field.disposition === "reject") throw new Error(field.reason);
        const policy = field.disposition === "apply" ? "execute" : field.disposition;
        cases.push({ id: fixture.id, kind: fixture.kind, status: "valid", expected: fixture.expected ?? null, expectedAbstention: fixture.expectedAbstention ?? false,
          modelChoice: answer.choice, topChoiceCorrect: fixture.expected ? answer.choice === fixture.expected : null,
          choice: field.selectedOptionId, selectedValue: field.selectedValue, correct: fixture.expected ? field.selectedOptionId === fixture.expected && field.disposition !== "clarify" : field.disposition === "clarify",
          confidence: answer.confidence, effectiveConfidence: field.effectiveConfidence, policyDefinition: definition.policy,
          disposition: field.disposition, reason: field.reason, diff: parsed.diff, policy,
          probabilities: answer.probabilities, candidateCount: Object.keys(fixture.question.criteria).length, latencyMs, provenance: result.provenance,
          ...(fixture.workflowGuard ? { workflowGuard: await verifyWorkflowGuard(client) } : {}),
        });
      } catch (error) {
        cases.push({ id: fixture.id, kind: fixture.kind, status: "invalid", error: error instanceof Error ? error.message : String(error), candidateCount: Object.keys(fixture.question.criteria).length });
      }
    }
    const valid = cases.filter((item) => item.status === "valid");
    const labeled = cases.filter((item) => item.expected !== null && item.expected !== undefined);
    const labeledCount = fixtureSet.cases.filter((item) => item.expected).length;
    const sorted = timings.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length ? sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2 : null;
    runs.push({ provider, status: "measured", metrics: {
      cases: cases.length, valid: valid.length, invalid: cases.length - valid.length,
      accuracy: labeledCount ? labeled.filter((item) => item.correct).length / labeledCount : null,
      topChoiceAccuracy: labeledCount ? labeled.filter((item) => item.topChoiceCorrect).length / labeledCount : null,
      overallCaseAccuracy: cases.length ? valid.filter((item) => item.correct).length / cases.length : null,
      labeledCases: labeledCount,
      abstained: valid.filter((item) => item.policy === "clarify").length,
      ambiguousAbstentions: valid.filter((item) => item.expectedAbstention && item.policy === "clarify").length,
      ambiguousCases: fixtureSet.cases.filter((item) => item.expectedAbstention).length,
      review: valid.filter((item) => item.policy === "review").length,
      execute: valid.filter((item) => item.policy === "execute").length,
      workflowGuards: valid.filter((item) => item.workflowGuard).length,
      workflowGuardsPassed: valid.filter((item) => item.workflowGuard && (item.workflowGuard as { passed: boolean }).passed).length,
      medianLatencyMs: median === null ? null : Math.round(median * 100) / 100,
      minLatencyMs: sorted[0] ?? null, maxLatencyMs: sorted.at(-1) ?? null,
      candidateRange: [Math.min(...fixtureSet.cases.map((item) => Object.keys(item.question.criteria).length)), Math.max(...fixtureSet.cases.map((item) => Object.keys(item.question.criteria).length))],
      runtimeCost: provider === "julia" ? { hostedApiRequests: 0, marginalApiUsd: 0, cpuEnergyUsd: null, note: "CPU electricity and hardware cost were not measured; model download/setup/load excluded from request latency." } : provider === "demo" ? { simulated: true, marginalApiUsd: 0 } : { usd: null, note: "No API billing record available." },
    }, cases });
  }
  const report = { schemaVersion: 1, timestamp: new Date().toISOString(), fixtureVersion: fixtureSet.version,
    fixtureSha256: createHash("sha256").update(fixtureBytes).digest("hex"), fixturePath,
    environment: { node: process.version, platform: process.platform, architecture: process.arch },
    protocol: "One adapter request per fixture in file order. Persistent service/model reused; earlier smoke calls may have warmed it. The production parseDecisionSurface applies OPERATION_POLICY to operations, LAYER_POLICY to layers/20-option boundary, and DISTANCE_POLICY to distances (including ambiguous distance). Accuracy measures the policy-selected legal candidate and counts invalid/clarify outcomes as incorrect on labeled cases; topChoiceAccuracy measures the raw model winner. Each case stores disposition, effective evidence, typed diff and policy definition. Ambiguous correctness requires clarify. No thresholds fitted to these fixtures. Small hand-labeled set is a smoke evaluation, not statistical qualification.",
    runtime: { julia: { modelBytes: await stat(".julia-model/model.safetensors").then((file) => file.size).catch(() => null), upstreamFp32MiB: 550.5, extraBrowserModelBytes: 0, cpuConfiguration: { strictEncoding: true, maxLength: 8192, headLength: 512, markerOnlyHead: false }, localPythonEnvironment: pythonEnvironment(), dependencies: "Optional Python 3.11+, torch, transformers, safetensors, numpy and upstream julia package; excluded from browser bundle." } }, runs };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ outputPath, runs: runs.map(({ provider, status, metrics }) => ({ provider, status, metrics })) }, null, 2));
}

function fixtureField(fixture: Fixture): DecisionField<unknown> {
  const distance = fixture.kind === "distance" || fixture.id === "ambiguous-distance";
  const layer = fixture.kind === "layer" || fixture.id === "maximum-twenty-options";
  return {
    label: fixture.kind, question: String(fixture.question.instructions), currentValue: null,
    options: Object.entries(fixture.question.criteria).map(([id, description]) => ({
      id, value: distance ? Number.parseFloat(id) * (id.endsWith("km") ? 1000 : 1) : id,
      description: String(description),
    })),
    policy: distance ? DISTANCE_POLICY : layer ? LAYER_POLICY : OPERATION_POLICY,
  };
}

async function verifyWorkflowGuard(client: ReturnType<typeof createDecisionClient>) {
  // Exercise the application lifecycle with real decisions and a mutated map state.
  const data = { type: "FeatureCollection", features: [{ type: "Feature", id: "school-1", properties: { name: "School" }, geometry: { type: "Point", coordinates: [-118.2, 34] } }] } as const;
  const spatialData = JSON.parse(JSON.stringify(data));
  const state = { intent: "Export the schools layer as GeoJSON.", viewport: { bbox: [-118.3, 33.9, -118.1, 34.1], zoom: 12 }, layers: [summarizeFeatureCollection("schools", "Schools", spatialData)], selection: { featureIds: [] }, previousActions: [] };
  const context = { layers: new Map([["schools", spatialData]]) };
  const plan = await workflow.createSpatialDecisionPlan(state, client, context);
  const prepared = await workflow.prepareSpatialDecision(plan, state, context);
  // A deliberate application-level review policy exercises the approval gate
  // without modifying model answers, confidence, or probabilities.
  const canReview = prepared.policy === "execute" || prepared.policy === "review";
  const reviewPlan = canReview ? { ...prepared, policy: "review" as const } : prepared;
  const pendingReceipt = workflow.spatialDecisionReceipt(reviewPlan);
  const unapproved = await workflow.executeSpatialDecision(reviewPlan, state, context, { receipt: pendingReceipt });
  const approved = await workflow.executeSpatialDecision(reviewPlan, state, context, { approved: true, receipt: pendingReceipt });
  const changed = { ...state, intent: "Buffer schools 500 meters instead." };
  const stale = await workflow.executeSpatialDecision(reviewPlan, changed, context, { approved: true, receipt: pendingReceipt });
  const blocked = !stale.result && stale.receipt.execution.status === "not-run";
  const approvalBlocked = !unapproved.result && unapproved.receipt.execution.status === "pending";
  return { planAction: plan.decisions.action.selectedValue, planPolicy: plan.policy, preparedPolicy: prepared.policy, originalCall: plan.call ?? null, preparedGuard: prepared.guard, applicationReviewOverride: canReview,
    decisionFields: Object.fromEntries(Object.entries(plan.decisions).map(([id, field]) => [id, { selectedOptionId: field.selectedOptionId ?? null, selectedValue: field.selectedValue ?? null, confidence: field.confidence ?? null, disposition: field.disposition, reason: field.reason }])),
    passed: blocked && approvalBlocked && approved.receipt.execution.success,
    approvalBlockedWithoutConfirmation: approvalBlocked,
    approvedExecution: approved.receipt.execution, outputFeatureCount: approved.result?.data.features.length ?? null,
    receiptProvenance: approved.receipt.provenance,
    blocked, execution: stale.receipt.execution, validation: stale.receipt.validation };
}

function pythonEnvironment() {
  try {
    const executable = process.env.JULIA_PYTHON ?? (process.platform === "win32" ? ".julia-env/Scripts/python.exe" : ".julia-env/bin/python");
    return JSON.parse(execFileSync(executable, ["-c", "import json,platform,torch,transformers,numpy,hashlib; from pathlib import Path; weights=Path('.julia-model/model.safetensors'); digest=hashlib.file_digest(weights.open('rb'),'sha256').hexdigest() if weights.exists() else None; print(json.dumps({'python':platform.python_version(),'torch':torch.__version__,'transformers':transformers.__version__,'numpy':numpy.__version__,'cpuThreads':torch.get_num_threads(),'weightsSha256':digest}))"], { encoding: "utf8", timeout: 30_000 }));
  } catch {
    return null;
  }
}
