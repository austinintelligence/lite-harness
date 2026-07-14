import io
import json
import unittest
from unittest.mock import patch

from lite_harness import LiteHarnessClient


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class ClientTests(unittest.TestCase):
    @patch("lite_harness.client.urlopen")
    def test_create_run_sends_identity_and_idempotency(self, open_url):
        open_url.return_value = Response(json.dumps({"runId": "run_1", "status": "ACCEPTED"}).encode())
        client = LiteHarnessClient("http://127.0.0.1:3210", "token", tenant_id="tenant", user_id="user")
        result = client.create_run(agent="coder", workspace="demo", input="work", idempotency_key="once")
        request = open_url.call_args.args[0]
        self.assertEqual(result["runId"], "run_1")
        self.assertEqual(request.headers["Idempotency-key"], "once")
        self.assertEqual(request.headers["X-lite-tenant-id"], "tenant")

    @patch("lite_harness.client.urlopen")
    def test_replays_sse_data_frames(self, open_url):
        event = {"runId": "run_1", "sequence": 1, "type": "run.accepted", "payload": {}}
        open_url.return_value = Response(f"event: run.accepted\ndata: {json.dumps(event)}\n\n".encode())
        client = LiteHarnessClient("http://127.0.0.1:3210", "token")
        self.assertEqual(list(client.events("run_1")), [event])


if __name__ == "__main__":
    unittest.main()
