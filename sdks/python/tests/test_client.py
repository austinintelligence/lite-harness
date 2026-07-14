import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from lite_harness import LiteHarnessClient, LiteHarnessError


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

    @patch("lite_harness.client.urlopen")
    def test_preserves_versioned_error_fields(self, open_url):
        body = json.dumps({"error": {
            "version": 1,
            "code": "rate_limited",
            "message": "Try later",
            "retryable": True,
            "retryAfterMs": 250,
            "details": {"provider": "fixture"},
        }}).encode()
        open_url.side_effect = HTTPError("http://127.0.0.1/v1/runs/run_1", 429, "rate", {}, Response(body))
        client = LiteHarnessClient("http://127.0.0.1:3210", "token")
        with self.assertRaises(LiteHarnessError) as raised:
            client.get_run("run_1")
        self.assertEqual(raised.exception.code, "rate_limited")
        self.assertTrue(raised.exception.retryable)
        self.assertEqual(raised.exception.retry_after_ms, 250)


if __name__ == "__main__":
    unittest.main()
