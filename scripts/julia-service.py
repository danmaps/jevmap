"""Optional resident Julia 1 CPU adapter. Uses no hosted model credentials.

Run: python scripts/julia-service.py --model-dir .julia-model
The real model package must be installed from that pinned model snapshot first.
"""

import argparse
import hashlib
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

MODEL = "SupersonicLabs/Julia-1"
REVISION = "a85b127321d580d65176c89ced8273f305745d85"
MAX_BYTES = 262_144
DEFAULT_ORIGINS = {"http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173"}


def validate_request(payload):
    if not isinstance(payload, dict) or set(payload) != {"state", "questions"}:
        raise ValueError("Supply only state and named questions; executable code is never accepted.")
    if not isinstance(payload["state"], (str, dict, list)):
        raise ValueError("State must be a string, object, or array.")
    questions = payload["questions"]
    if not isinstance(questions, dict) or not 1 <= len(questions) <= 16:
        raise ValueError("Supply 1–16 named choice questions.")
    for name, question in questions.items():
        if not isinstance(name, str) or not name.strip() or not isinstance(question, dict) or question.get("type") != "choice":
            raise ValueError("Only named bounded choice questions are supported.")
        if set(question) - {"type", "instructions", "criteria"}:
            raise ValueError("Unexpected question fields.")
        if not isinstance(question.get("instructions", ""), str):
            raise ValueError("Question instructions must be a string.")
        criteria = question.get("criteria")
        if not isinstance(criteria, dict) or not 2 <= len(criteria) <= 20:
            raise ValueError("Native Julia inference requires 2–20 candidates per question.")
        if any(not isinstance(key, str) or not key.strip() or not isinstance(value, str) or not value.strip() for key, value in criteria.items()):
            raise ValueError("Candidates require nonempty caller-defined IDs and descriptions.")
    return payload["state"], questions


def create_server(engine, host="127.0.0.1", port=8765, revision=REVISION, allowed_origins=None):
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("The local Julia service must bind to loopback; use an authenticated reverse proxy for hosting.")
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Revision must be the downloaded Hugging Face commit SHA.")
    origins = set(DEFAULT_ORIGINS if allowed_origins is None else allowed_origins)
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # Never write feature state or questions to the request log.

        def send_json(self, status, payload):
            body = json.dumps(payload, allow_nan=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            origin = self.headers.get("Origin")
            if origin in origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Access-Control-Allow-Private-Network", "true")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_json(200 if self.headers.get("Origin") in origins else 403, {})

        def do_POST(self):
            if urlsplit(self.path).path != "/api/julia":
                self.send_json(404, {"error": "Unknown endpoint."})
                return
            if self.headers.get("Origin") and self.headers["Origin"] not in origins:
                self.send_json(403, {"error": "Origin is not allowed by the local Julia service."})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BYTES:
                    self.send_json(413, {"error": "Julia requests must fit within 256 KiB; reduce map summaries."})
                    return
                if self.headers.get_content_type() != "application/json":
                    self.send_json(415, {"error": "Use application/json."})
                    return
                payload = json.loads(self.rfile.read(length))
                state, questions = validate_request(payload)
                with lock:
                    result = engine.predict(state=state, questions=questions)
                if not isinstance(result, dict) or not isinstance(result.get("answers"), dict):
                    raise RuntimeError("Julia did not return the documented named-question answers.")
                self.send_json(200, {
                    "model": MODEL,
                    "answers": result["answers"],
                    "provenance": {"backend": "julia", "runtime": "python-cpu", "model": MODEL, "version": revision, "simulated": False},
                })
            except (ValueError, UnicodeDecodeError) as error:
                self.send_json(422, {"error": str(error)})
            except Exception:
                self.send_json(500, {"error": "Julia inference failed. Verify the installed runtime, checkpoint, and strict encoding limits."})

    return ThreadingHTTPServer((host, port), Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", default=".julia-model")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--allow-origin", action="append", default=[])
    args = parser.parse_args()
    model_dir = Path(args.model_dir).resolve()
    marker = model_dir / ".jevmap-revision"
    if not marker.exists():
        parser.error("Missing .jevmap-revision marker. Follow docs/JULIA.md to download the pinned snapshot.")
    revision = marker.read_text(encoding="utf-8").strip()
    if revision != REVISION:
        parser.error("Checkpoint revision differs from the adapter's evaluated revision. Update both intentionally before running.")
    with (model_dir / "model.safetensors").open("rb") as weights:
        if hashlib.file_digest(weights, "sha256").hexdigest() != "df853bf7fe424420011f3d0c47a05d7341aa9eefa7fb9f203ea4aada4ad95b72":
            parser.error("Weights differ from the pinned Julia checkpoint SHA-256. Download the snapshot again.")
    from julia import load_model  # Optional dependency: never imported for normal Jev builds/tests.

    # Match the upstream CPU FP32 accuracy harness; CPU's faster marker-only
    # default is a different decision-head path and is not its evaluated setup.
    engine = load_model(str(model_dir), device="cpu", strict_encoding=True, max_length=8192, head_length=512, marker_only_head=False)
    server = create_server(engine, port=args.port, revision=revision, allowed_origins=DEFAULT_ORIGINS | set(args.allow_origin))
    print(f"Julia 1 {revision} loaded on CPU; listening at http://127.0.0.1:{args.port}/api/julia", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
