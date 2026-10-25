# Spatial decision evaluation

The [recorded Julia CPU run](julia-cpu.json) uses the real checkpoint through the production Julia adapter and local service. The fixture SHA-256, model revision, local Python package versions, every probability distribution, and per-request times are stored in that file. This is a small domain smoke evaluation; it does not establish comparative accuracy against Jev or justify a default change.

| Measure | Julia CPU | Jev |
| --- | --- | --- |
| Valid responses | 14/14 | Not run |
| Correct raw model winners / policy-selected choices | 12/12 / 12/12 | Not run |
| Ambiguous cases correctly abstained | 0/2 | Not run |
| Overall case correctness | 12/14 (85.7%) | Not run |
| Invalid responses | 0 | Not run |
| Policy clarification / review | 0 / 1 | Not run |
| Median adapter/HTTP latency | See JSON (single resident-service pass) | Not run |
| Native candidate range | 2–20 | Not run |
| Hosted API charge | $0; local hardware/electricity unmeasured | Not run |
| Extra browser model download | 0 bytes | Existing hosted proxy |

Jev is explicitly `not-run`, with null metrics, because no authorized absolute proxy endpoint was configured. No Jev numbers are copied from vendor benchmarks or fabricated from demo responses. Set `JEV_EVALUATION_ENDPOINT` and rerun the harness to obtain the comparison under the same fixture protocol before considering a default change.

The runner applies the production per-field policies through `parseDecisionSurface`: the operation winner policy, layer winner policy, and ordered-distance policy. It stores both the raw model winner and the policy-selected typed candidate, disposition, effective confidence, and diff. Policy thresholds and margins are recorded with each case and were not fitted to these fixtures.

Both ambiguous goals reached apply under those policies. The ambiguous distance had model confidence about 0.686 but ordered probability concentration about 0.872, so the ordered policy applied its legal median candidate. The operation had high winner confidence despite the vague goal. Neither case abstained. This demonstrates that probability-based policy cannot guarantee clarification when the goal omits essential intent or distance. The default remains Jev, and Julia remains an explicit optional backend.

In a separate browser smoke test outside this fixture set, Julia chose the nearest operation but reversed its input and target layers for “Find the nearest landmark for each Los Angeles demo point.” It produced three landmark-to-point lines instead of eight point-to-landmark lines with high confidence. This observation is not included in the fixture metrics; it demonstrates that valid typed parameters can still misinterpret a directional goal.

The stale-state fixture also exercises a separate real model workflow on a school layer: export choice → typed parameters → application review policy → pending receipt → execution blocked without approval → successful approved deterministic execution → execution blocked after the goal changes. This test deliberately forces application review without changing model answers or confidence, so it tests the approval gate even when the model's normal policy result is execute. Its receipt retains actual Julia provenance. Contract tests separately prove malformed output rejection and low-confidence clarification; those tests use fake response payloads and are not model measurements.

The optional FP32 weights occupy 577,189,056 bytes on this run. Python, PyTorch, Transformers, tokenizer and activation memory are additional. Installation, checkpoint download and initial load are excluded from request latency. The resident service may have received earlier smoke requests; CPU contention and cache state were not controlled. This report measures no electricity charge or total operating cost.

Run `node scripts/run-evaluation.mjs --providers=julia,jev --output=docs/evaluation/julia-cpu.json` with the service running. Details and setup are in [JULIA.md](../JULIA.md). Predictions are deterministic on this recorded CPU configuration, but timing varies and other runtime versions/hardware may change close decisions.
