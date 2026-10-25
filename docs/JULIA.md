# Optional Julia 1 backend

Jev-latest remains the default through `/api/jev`, as required by issue #4. Julia 1 is explicitly selectable and uses the real checkpoint through `/api/julia`. Failed requests remain errors and never switch provider automatically. All experimental Julia calls require concrete review even when field policies report apply, because the domain evaluation exposes overconfident mistakes and ambiguity.

The adapter implements the upstream [named-question Python API](https://huggingface.co/SupersonicLabs/Julia-1) at revision `a85b127321d580d65176c89ced8273f305745d85`. It maps caller-defined IDs and full softmax probabilities to JevMap's existing `ChoiceAnswer`; `max_probability` becomes policy confidence. JevMap supports choice questions only on this path. Scores are uncalibrated, so confidence can be high for a wrong answer.

The [upstream ONNX/WebGPU export](https://huggingface.co/SupersonicLabs/Julia-1-ONNX) is available, but this implementation uses a small Python service so the browser bundle carries no checkpoint or inference framework. CPU inference works without a GPU. The FP32 checkpoint is about 550.5 MiB, with additional runtime and activation memory. No hosted credentials are needed.

## Setup

Install Python 3.11+ and download the optional runtime into the repository. On Windows PowerShell:

```powershell
python -m venv .julia-env
.\.julia-env\Scripts\python.exe -m pip install huggingface_hub "torch>=2.6" "transformers>=5.0,<5.1" "safetensors>=0.5" "numpy>=1.26"
.\.julia-env\Scripts\python.exe scripts/download-julia.py
.\.julia-env\Scripts\python.exe -m pip install --no-deps --no-build-isolation -e ./.julia-model
.\.julia-env\Scripts\python.exe scripts/julia-service.py
```

On macOS/Linux, use `.julia-env/bin/python` instead of `.julia-env\Scripts\python.exe`; install `setuptools>=70` in the environment before the editable package command if missing. The downloaded model and environment are ignored by Git.

The download and startup verify the pinned weight SHA-256. The service loads the model once and listens on `http://127.0.0.1:8765/api/julia`. Its CPU settings are FP32, strict encoding, 8192 combined tokens, a 512-token question/options budget, and `marker_only_head=False`, matching the decision-head path in the upstream CPU accuracy harness. The upstream per-option token limit also applies. Oversized input fails; the adapter never silently truncates or shortlists candidates.

Start the app with `npm run dev`, select Julia, and submit a task. Vite proxies the browser's same-origin `/api/julia` request to the local service. For production, configure the same-origin reverse proxy separately. Review/approval, stale-state guards, runtime Workbench validation, deterministic geometry, and receipts apply. The decision panel and receipts identify provider, runtime, model revision, and confidence.

For another service route, set `VITE_JULIA_ENDPOINT` to its URL before starting/building the app. The local service permits Vite localhost origins on ports 5173 and 4173. Add an exact origin with `--allow-origin https://your-site.example` if needed. It refuses public network binding. For remote hosting, put it behind an authenticated, rate-limited same-origin reverse proxy; do not expose the loopback service directly.

## Boundaries and tradeoffs

Native Julia requests contain 2–20 legal candidates. A question with one legal candidate is resolved deterministically with probability 1 and is omitted from model inference. Empty candidate sets and sets larger than 20 fail before networking; no fake alternatives or grouped probability claims are introduced. The service also limits each request to 16 questions and 256 KiB, accepts only the typed choice schema, and serializes inference through one resident engine. Model outputs never contain executable GIS code.

The first use includes package setup, model download and startup. Subsequent requests reuse the resident model. Local inference avoids API charges but still consumes CPU, memory and electricity; a zero API charge is not a measured total operating cost. `usageReported=false` prevents fabricated token/cost numbers.

Receipts record `answerSources` for every Julia question. Singleton choices use `deterministic` runtime provenance; mixed/model requests use CPU provenance. The workflow's overall provenance comes from an actual inference response when present, and the live panel labels singleton fields as application decisions rather than CPU model predictions.

The adapter requires exact question and candidate names, a complete normalized probability distribution, finite values, and a winner/max probability consistent with that distribution. Low confidence reaches the existing clarification or review policy. Confidence alone cannot detect an overconfident mistake or an ambiguous request. Review the actual choices and legal parameters before approving a result.

## Reproduce evaluation

```powershell
python scripts/test-julia-service.py
npm test -- tests/providers.test.ts
node scripts/run-evaluation.mjs --providers=julia,jev --output=docs/evaluation/julia-cpu.json
```

The runner reuses Vite's TypeScript loader, production adapters, and `parseDecisionSurface` with the application's operation, layer and ordered-distance policies. Its hand-labeled [fixture set](../tests/fixtures/decision-evaluation.json) includes all six operations, named layers, distances, ambiguous goals, 2/20-option boundaries, and a changed-state execution guard. It records the fixture hash, checkpoint provenance, raw winners/probabilities, policy-selected typed candidates/diffs, validity, policy abstentions, accuracy, request latency, and runtime footprint/cost limits. Latency includes the adapter/HTTP path and excludes installation, download and initial model load; it is a single pass through a resident service, not a statistical benchmark.

For a live Jev comparison, set `JEV_EVALUATION_ENDPOINT` to an explicitly authorized absolute server-side proxy URL. The runner does not discover credentials or endpoints. Without that setting it records Jev as `not-run` with null metrics. `JULIA_EVALUATION_ENDPOINT` overrides Julia's endpoint.

See the [recorded CPU run](evaluation/julia-cpu.json), its [interpretation](evaluation/README.md), and the [independent PR review](review/README.md). Julia remains optional; no vendor benchmark qualifies it as the default for these spatial tasks.
