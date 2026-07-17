import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from lite_harness import (
    API_OPERATIONS,
    AUTHENTICATED_OPERATION_METHODS,
    AUTHENTICATED_OPERATION_ROUTES,
    LiteHarnessClient,
    LiteHarnessError,
)


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


class DisconnectingResponse(Response):
    def __iter__(self):
        yield from io.BytesIO(self.getvalue())
        raise OSError("fixture disconnect")


def event(run_id: str, sequence: int, event_type: str) -> dict[str, object]:
    return {"runId": run_id, "sequence": sequence, "type": event_type, "payload": {}, "createdAt": "2026-01-01T00:00:00Z"}


def sse(*events: dict[str, object]) -> bytes:
    return "".join(f"data: {json.dumps(item)}\n\n" for item in events).encode()


class ClientTests(unittest.TestCase):
    def test_authenticated_openapi_operation_inventory_has_method_path_and_verb_coverage(self):
        expected = tuple(
            (method, path, operation_id, AUTHENTICATED_OPERATION_METHODS[operation_id])
            for method, path, operation_id in API_OPERATIONS
            if path.startswith("/v1/")
        )
        self.assertEqual(AUTHENTICATED_OPERATION_ROUTES, expected)
        self.assertEqual(len(expected), 20)
        for _method, _path, _operation_id, method_name in expected:
            self.assertTrue(callable(getattr(LiteHarnessClient, method_name, None)), method_name)

    @patch("lite_harness.client.urlopen")
    def test_resource_and_artifact_methods_use_the_generated_routes(self, open_url):
        responses = [
            {"id": "session-1"},
            {"messages": []},
            {"id": "artifact-1"},
            {"record": {"id": "artifact-1"}, "dataBase64": "aGVsbG8="},
            {"id": "agent-1"},
            {"id": "agent-1"},
            {"agents": []},
            {"id": "workspace-1"},
            {"id": "workspace-1"},
            {"workspaces": []},
        ]
        open_url.side_effect = [Response(json.dumps(value).encode()) for value in responses]
        client = LiteHarnessClient("http://127.0.0.1:3210", "token")

        client.get_session("session-1")
        client.get_session_messages("session-1")
        client.publish_artifact("run-1", path="output.txt", media_type="text/plain")
        downloaded = client.download_artifact("artifact-1")
        client.create_agent(name="coder", agent_id="agent-1")
        client.get_agent("agent-1")
        client.list_agents()
        client.create_workspace(workspace_id="workspace-1", mode="managed")
        client.get_workspace("workspace-1")
        client.list_workspaces()

        requests = [call.args[0] for call in open_url.call_args_list]
        self.assertEqual(
            [(request.method, request.full_url) for request in requests],
            [
                ("GET", "http://127.0.0.1:3210/v1/sessions/session-1"),
                ("GET", "http://127.0.0.1:3210/v1/sessions/session-1/messages"),
                ("POST", "http://127.0.0.1:3210/v1/runs/run-1/artifacts"),
                ("GET", "http://127.0.0.1:3210/v1/artifacts/artifact-1"),
                ("POST", "http://127.0.0.1:3210/v1/agents"),
                ("GET", "http://127.0.0.1:3210/v1/agents/agent-1"),
                ("GET", "http://127.0.0.1:3210/v1/agents"),
                ("POST", "http://127.0.0.1:3210/v1/workspaces"),
                ("GET", "http://127.0.0.1:3210/v1/workspaces/workspace-1"),
                ("GET", "http://127.0.0.1:3210/v1/workspaces"),
            ],
        )
        self.assertEqual(json.loads(requests[2].data), {"path": "output.txt", "mediaType": "text/plain"})
        self.assertEqual(json.loads(requests[4].data), {"name": "coder", "id": "agent-1"})
        self.assertEqual(json.loads(requests[7].data), {"id": "workspace-1", "mode": "managed"})
        self.assertEqual(downloaded, {"record": {"id": "artifact-1"}, "data": b"hello"})

    @patch("lite_harness.client.urlopen")
    def test_create_run_sends_credential_and_idempotency_without_identity_headers(self, open_url):
        open_url.return_value = Response(json.dumps({"runId": "run_1", "status": "ACCEPTED"}).encode())
        client = LiteHarnessClient("http://127.0.0.1:3210", "token")
        result = client.create_run(agent="coder", workspace="demo", input="work", idempotency_key="once")
        request = open_url.call_args.args[0]
        self.assertEqual(result["runId"], "run_1")
        self.assertEqual(request.headers["Idempotency-key"], "once")
        self.assertEqual(request.headers["Authorization"], "Bearer token")
        self.assertNotIn("X-lite-tenant-id", request.headers)
        self.assertNotIn("X-lite-user-id", request.headers)

    @patch("lite_harness.client.urlopen")
    def test_replays_sse_data_frames(self, open_url):
        event = {"runId": "run_1", "sequence": 1, "type": "run.accepted", "payload": {}, "createdAt": "2026-01-01T00:00:00Z"}
        open_url.side_effect = [
            Response(sse(event)),
            Response(json.dumps({"status": "SUCCEEDED", "lastSequence": 1}).encode()),
        ]
        client = LiteHarnessClient("http://127.0.0.1:3210", "token")
        self.assertEqual(list(client.events("run_1")), [event])

    @patch("lite_harness.client.urlopen")
    def test_reconnects_after_disconnect_with_sequence_cursor_and_last_event_id(self, open_url):
        first = event("run_1", 1, "run.accepted")
        second = event("run_1", 2, "run.succeeded")
        open_url.side_effect = [
            DisconnectingResponse(sse(first)),
            Response(sse(second)),
            Response(json.dumps({"status": "SUCCEEDED", "lastSequence": 2}).encode()),
        ]
        client = LiteHarnessClient("http://127.0.0.1:3210", "token")

        self.assertEqual(list(client.events("run_1", reconnect_delay_ms=0, max_retries=2)), [first, second])
        stream_requests = [call.args[0] for call in open_url.call_args_list[:2]]
        self.assertEqual([request.full_url for request in stream_requests], [
            "http://127.0.0.1:3210/v1/runs/run_1/events?after=0",
            "http://127.0.0.1:3210/v1/runs/run_1/events?after=1",
        ])
        self.assertEqual([request.headers["Last-event-id"] for request in stream_requests], ["0", "1"])

    @patch("lite_harness.client.urlopen")
    def test_suppresses_duplicate_replay_frames(self, open_url):
        first = event("run_1", 1, "run.accepted")
        second = event("run_1", 2, "run.succeeded")
        open_url.side_effect = [
            Response(sse(first)),
            Response(json.dumps({"status": "RUNNING", "lastSequence": 2}).encode()),
            Response(sse(first, second)),
            Response(json.dumps({"status": "SUCCEEDED", "lastSequence": 2}).encode()),
        ]
        client = LiteHarnessClient("http://127.0.0.1:3210", "token")

        self.assertEqual(list(client.events("run_1", reconnect_delay_ms=0, max_retries=2)), [first, second])
        stream_requests = [call.args[0] for call in open_url.call_args_list if "/events?" in call.args[0].full_url]
        self.assertEqual([request.full_url for request in stream_requests], [
            "http://127.0.0.1:3210/v1/runs/run_1/events?after=0",
            "http://127.0.0.1:3210/v1/runs/run_1/events?after=1",
        ])

    @patch("lite_harness.client.urlopen")
    def test_rejects_sequence_gap_without_retry(self, open_url):
        open_url.return_value = Response(sse(event("run_1", 1, "run.accepted"), event("run_1", 3, "run.succeeded")))
        client = LiteHarnessClient("http://127.0.0.1:3210", "token")

        with self.assertRaises(LiteHarnessError) as raised:
            list(client.events("run_1", reconnect_delay_ms=0))
        self.assertEqual(raised.exception.code, "event_sequence_gap")
        self.assertEqual(open_url.call_count, 1)

    @patch("lite_harness.client.urlopen")
    def test_stops_when_terminal_run_has_no_unread_events(self, open_url):
        accepted = event("run_1", 1, "run.accepted")
        open_url.side_effect = [
            Response(sse(accepted)),
            Response(json.dumps({"status": "FAILED", "lastSequence": 1}).encode()),
        ]
        client = LiteHarnessClient("http://127.0.0.1:3210", "token")

        self.assertEqual(list(client.events("run_1", reconnect_delay_ms=0)), [accepted])
        self.assertEqual(open_url.call_count, 2)

    @patch("lite_harness.client.urlopen", side_effect=OSError("fixture disconnect"))
    def test_bounds_reconnect_retries(self, open_url):
        client = LiteHarnessClient("http://127.0.0.1:3210", "token")

        with self.assertRaises(LiteHarnessError) as raised:
            list(client.events("run_1", reconnect_delay_ms=0, max_retries=2))
        self.assertEqual(raised.exception.code, "event_stream_retry_exhausted")
        self.assertEqual(open_url.call_count, 3)

    @patch("lite_harness.client.urlopen")
    def test_bounds_clean_eof_reconnects_for_nonterminal_run(self, open_url):
        status = Response(json.dumps({"status": "RUNNING", "lastSequence": 0}).encode())
        open_url.side_effect = [Response(b""), status, Response(b""), Response(json.dumps({"status": "RUNNING", "lastSequence": 0}).encode()), Response(b""), Response(json.dumps({"status": "RUNNING", "lastSequence": 0}).encode())]
        client = LiteHarnessClient("http://127.0.0.1:3210", "token")

        with self.assertRaises(LiteHarnessError) as raised:
            list(client.events("run_1", reconnect_delay_ms=0, max_retries=2))
        self.assertEqual(raised.exception.code, "event_stream_retry_exhausted")
        self.assertEqual(open_url.call_count, 6)

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
