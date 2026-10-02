"""Contract tests using an injected fake engine, not model-quality measurements."""
import importlib.util
import json
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location("julia_service", Path(__file__).with_name("julia-service.py"))
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class FakeEngine:
    def __init__(self):
        self.calls = []

    def predict(self, **kwargs):
        self.calls.append(kwargs)
        return {"answers": {name: {"type": "choice", "choice": next(iter(question["criteria"])), "max_probability": 0.75,
                           "probabilities": dict(zip(question["criteria"], [0.75, 0.25]))} for name, question in kwargs["questions"].items()}}


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()
        self.server = service.create_server(self.engine, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/api/julia"
        self.payload = {"state": {"intent": "Buffer schools"}, "questions": {"operation": {"type": "choice", "criteria": {"buffer": "Create distance zone", "export": "Export data"}}}}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, payload=None, origin="http://localhost:5173"):
        request = Request(self.url, data=json.dumps(self.payload if payload is None else payload).encode(), headers={"Content-Type": "application/json", "Origin": origin})
        try:
            response = urlopen(request)
        except HTTPError as error:
            response = error
        return response.status, json.loads(response.read()), response.headers

    def test_native_mapping_and_provenance(self):
        status, result, headers = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(self.engine.calls[0], self.payload)
        self.assertEqual(result["answers"]["operation"]["choice"], "buffer")
        self.assertEqual(result["provenance"]["runtime"], "python-cpu")
        self.assertFalse(result["provenance"]["simulated"])
        self.assertEqual(headers["Access-Control-Allow-Origin"], "http://localhost:5173")

    def test_no_inference_for_invalid_or_unbounded_requests(self):
        for count in [0, 1, 21]:
            self.payload["questions"]["operation"]["criteria"] = {str(index): "Description" for index in range(count)}
            self.assertEqual(self.request()[0], 422)
        self.payload["questions"]["operation"]["criteria"] = {"buffer": "Buffer", "code": "exec"}
        self.payload["questions"]["operation"]["script"] = "arbitrary code"
        self.assertEqual(self.request()[0], 422)
        self.assertEqual(self.engine.calls, [])

    def test_disallowed_origin_cannot_infer(self):
        self.assertEqual(self.request(origin="https://untrusted.example")[0], 403)
        self.assertEqual(self.engine.calls, [])

    def test_service_refuses_public_binding(self):
        with self.assertRaises(ValueError):
            service.create_server(self.engine, host="0.0.0.0")


if __name__ == "__main__":
    unittest.main()
