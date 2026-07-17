from __future__ import annotations

import base64
import json
import re
import time
import uuid
from collections.abc import Iterator
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urljoin
from urllib.request import Request, urlopen

from .generated_api import API_OPERATIONS


# The generated OpenAPI inventory is the source of truth for the public REST
# surface.  The Python client intentionally excludes only the unauthenticated
# liveness/readiness/webhook routes; every authenticated /v1 operation must be
# represented by one client method.
AUTHENTICATED_OPERATION_METHODS: dict[str, str] = {
    "getV1Agents": "list_agents",
    "postV1Agents": "create_agent",
    "getV1AgentsByAgentId": "get_agent",
    "postV1ApprovalsByApprovalId": "resolve_approval",
    "getV1ArtifactsByArtifactId": "download_artifact",
    "postV1Runs": "create_run",
    "getV1RunsByRunId": "get_run",
    "postV1RunsByRunIdArtifacts": "publish_artifact",
    "getV1RunsByRunIdAttempts": "get_attempts",
    "postV1RunsByRunIdCancel": "cancel_run",
    "getV1RunsByRunIdChildren": "get_children",
    "getV1RunsByRunIdEvents": "events",
    "postV1RunsByRunIdSteer": "steer_run",
    "getV1SessionsBySessionId": "get_session",
    "getV1SessionsBySessionIdMessages": "get_session_messages",
    "postV1Tokens": "mint_run_token",
    "deleteV1TokensByTokenId": "revoke_token",
    "getV1Workspaces": "list_workspaces",
    "postV1Workspaces": "create_workspace",
    "getV1WorkspacesByWorkspaceId": "get_workspace",
}

_EXCLUDED_OPERATION_IDS = frozenset({"getHealthz", "postHooksWebhookByAccountId", "getReadyz"})
_OPERATION_ROUTES_BY_ID: dict[str, tuple[str, str]] = {
    operation_id: (method, path) for method, path, operation_id in API_OPERATIONS
}
AUTHENTICATED_OPERATION_ROUTES: tuple[tuple[str, str, str, str], ...] = tuple(
    (method, path, operation_id, AUTHENTICATED_OPERATION_METHODS[operation_id])
    for method, path, operation_id in API_OPERATIONS
    if operation_id in AUTHENTICATED_OPERATION_METHODS
)


class LiteHarnessError(RuntimeError):
    def __init__(
        self,
        message: str,
        status: int | None = None,
        *,
        code: str = "request_failed",
        retryable: bool = False,
        retry_after_ms: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.retryable = retryable
        self.retry_after_ms = retry_after_ms
        self.details = details


class LiteHarnessClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = 30.0,
    ) -> None:
        if not base_url or not token:
            raise ValueError("base_url and token are required")
        self._base_url = base_url.rstrip("/") + "/"
        self._token = token
        self._timeout = timeout

    def create_run(
        self,
        *,
        agent: str,
        workspace: str,
        input: str,
        session: str | None = None,
        budget: dict[str, int | float] | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"agent": agent, "workspace": workspace, "input": input}
        if session is not None:
            body["session"] = session
        if budget is not None:
            body["budget"] = budget
        return self._json_operation(
            "postV1Runs",
            body=body,
            headers={"Idempotency-Key": idempotency_key or str(uuid.uuid4())},
        )

    def mint_run_token(
        self,
        *,
        scopes: list[str],
        ttl_seconds: int = 900,
        agent_id: str | None = None,
        workspace_id: str | None = None,
        budget_ceiling: dict[str, int | float] | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"scopes": scopes, "ttlSeconds": ttl_seconds}
        if agent_id is not None:
            body["agentId"] = agent_id
        if workspace_id is not None:
            body["workspaceId"] = workspace_id
        if budget_ceiling is not None:
            body["budgetCeiling"] = budget_ceiling
        return self._json_operation("postV1Tokens", body=body)

    def revoke_token(self, token_id: str) -> dict[str, Any]:
        return self._json_operation("deleteV1TokensByTokenId", path_params={"tokenId": token_id})

    def get_run(self, run_id: str) -> dict[str, Any]:
        return self._json_operation("getV1RunsByRunId", path_params={"runId": run_id})

    def cancel_run(self, run_id: str) -> dict[str, Any]:
        return self._json_operation("postV1RunsByRunIdCancel", path_params={"runId": run_id})

    def steer_run(self, run_id: str, instruction: str) -> dict[str, Any]:
        return self._json_operation(
            "postV1RunsByRunIdSteer",
            path_params={"runId": run_id},
            body={"instruction": instruction},
        )

    def get_attempts(self, run_id: str) -> list[dict[str, Any]]:
        return self._json_operation("getV1RunsByRunIdAttempts", path_params={"runId": run_id})["attempts"]

    def get_children(self, run_id: str) -> list[dict[str, Any]]:
        return self._json_operation("getV1RunsByRunIdChildren", path_params={"runId": run_id})["runs"]

    def get_session(self, session_id: str) -> dict[str, Any]:
        return self._json_operation("getV1SessionsBySessionId", path_params={"sessionId": session_id})

    def get_session_messages(self, session_id: str) -> list[dict[str, Any]]:
        return self._json_operation(
            "getV1SessionsBySessionIdMessages",
            path_params={"sessionId": session_id},
        )["messages"]

    def resolve_approval(self, approval_id: str, approved: bool) -> dict[str, Any]:
        return self._json_operation(
            "postV1ApprovalsByApprovalId",
            path_params={"approvalId": approval_id},
            body={"approved": approved},
        )

    def publish_artifact(self, run_id: str, *, path: str, media_type: str) -> dict[str, Any]:
        return self._json_operation(
            "postV1RunsByRunIdArtifacts",
            path_params={"runId": run_id},
            body={"path": path, "mediaType": media_type},
        )

    def download_artifact(self, artifact_id: str) -> dict[str, Any]:
        payload = self._json_operation("getV1ArtifactsByArtifactId", path_params={"artifactId": artifact_id})
        try:
            data = base64.b64decode(payload["dataBase64"], validate=True)
        except (KeyError, TypeError, ValueError) as error:
            raise LiteHarnessError("Artifact response contained invalid base64 data", code="invalid_artifact_response") from error
        return {"record": payload["record"], "data": data}

    def create_agent(
        self,
        *,
        name: str,
        agent_id: str | None = None,
        instructions: str | None = None,
        model_capabilities: list[str] | None = None,
        allowed_tools: list[str] | None = None,
        default_budget: dict[str, int | float] | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"name": name}
        if agent_id is not None:
            body["id"] = agent_id
        if instructions is not None:
            body["instructions"] = instructions
        if model_capabilities is not None:
            body["modelCapabilities"] = model_capabilities
        if allowed_tools is not None:
            body["allowedTools"] = allowed_tools
        if default_budget is not None:
            body["defaultBudget"] = default_budget
        return self._json_operation("postV1Agents", body=body)

    def get_agent(self, agent_id: str) -> dict[str, Any]:
        return self._json_operation("getV1AgentsByAgentId", path_params={"agentId": agent_id})

    def list_agents(self) -> list[dict[str, Any]]:
        return self._json_operation("getV1Agents")["agents"]

    def create_workspace(
        self,
        *,
        workspace_id: str | None = None,
        mode: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if workspace_id is not None:
            body["id"] = workspace_id
        if mode is not None:
            body["mode"] = mode
        return self._json_operation("postV1Workspaces", body=body)

    def get_workspace(self, workspace_id: str) -> dict[str, Any]:
        return self._json_operation("getV1WorkspacesByWorkspaceId", path_params={"workspaceId": workspace_id})

    def list_workspaces(self) -> list[dict[str, Any]]:
        return self._json_operation("getV1Workspaces")["workspaces"]

    def events(
        self,
        run_id: str,
        after: int = 0,
        *,
        reconnect_delay_ms: int = 250,
        max_retries: int = 3,
    ) -> Iterator[dict[str, Any]]:
        """Replay a run's SSE stream with bounded, cursor-safe reconnects.

        ``after`` remains the original public cursor argument.  Each reconnect
        sends both the query cursor and ``Last-Event-ID`` so gateways that
        implement either replay convention resume from the same event.
        ``max_retries`` counts reconnect attempts after the initial request.
        """
        if not isinstance(after, int) or isinstance(after, bool) or after < 0:
            raise LiteHarnessError(
                "Event cursor must be a non-negative integer",
                code="invalid_event_cursor",
            )
        if not isinstance(reconnect_delay_ms, int) or isinstance(reconnect_delay_ms, bool) or not 0 <= reconnect_delay_ms <= 60_000:
            raise LiteHarnessError(
                "Reconnect delay must be between 0 and 60000 milliseconds",
                code="invalid_reconnect_delay",
            )
        if not isinstance(max_retries, int) or isinstance(max_retries, bool) or max_retries < 0:
            raise LiteHarnessError(
                "Maximum event stream retries must be a non-negative integer",
                code="invalid_event_stream_retries",
            )

        cursor = after
        retries = 0
        while True:
            request = self._event_request(run_id, cursor)
            try:
                with urlopen(request, timeout=self._timeout) as response:  # noqa: S310 - caller chooses the service URL
                    for payload in _iter_sse_payloads(response):
                        _validate_event_payload(payload, run_id)
                        sequence = payload["sequence"]
                        if sequence <= cursor:
                            continue
                        if sequence != cursor + 1:
                            raise LiteHarnessError(
                                f"Event stream sequence gap: expected {cursor + 1}, received {sequence}",
                                code="event_sequence_gap",
                            )
                        cursor = sequence
                        yield payload

                run = self.get_run(run_id)
                if (
                    run.get("status") in _TERMINAL_RUN_STATUSES
                    and isinstance(run.get("lastSequence"), int)
                    and cursor >= run["lastSequence"]
                ):
                    return
                # A clean HTTP EOF is still an interrupted stream. Route it
                # through the same retryable path as a transport disconnect so
                # it consumes the bounded reconnect budget instead of spinning
                # indefinitely on a nonterminal run.
                raise LiteHarnessError(
                    "Event stream closed before the run reached a terminal state",
                    code="event_stream_error",
                    retryable=True,
                )
            except HTTPError as error:
                stream_error = self._http_error(error)
                if not _is_retryable_event_stream_error(stream_error):
                    raise stream_error from error
                error = stream_error
            except (OSError, TimeoutError) as error:
                if not _is_retryable_event_stream_error(error):
                    raise
            except LiteHarnessError as error:
                if not _is_retryable_event_stream_error(error):
                    raise

            retries += 1
            if retries > max_retries:
                raise LiteHarnessError(
                    f"Event stream retries exhausted after {max_retries} reconnects",
                    code="event_stream_retry_exhausted",
                )
            if reconnect_delay_ms:
                time.sleep(reconnect_delay_ms / 1000)

    def _event_request(self, run_id: str, cursor: int) -> Request:
        query = urlencode({"after": cursor})
        method, path = _operation_route("getV1RunsByRunIdEvents", runId=run_id)
        return Request(
            self._url(f"{path.lstrip('/')}?{query}"),
            method=method,
            headers={
                **self._headers(),
                "Accept": "text/event-stream",
                "Last-Event-ID": str(cursor),
            },
        )

    def _json(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        payload = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        request = Request(
            self._url(path),
            data=payload,
            method=method,
            headers={**self._headers(), **({"Content-Type": "application/json"} if payload else {}), **(headers or {})},
        )
        try:
            with urlopen(request, timeout=self._timeout) as response:  # noqa: S310 - caller chooses the service URL
                return json.load(response)
        except HTTPError as error:
            raise self._http_error(error) from error

    def _json_operation(
        self,
        operation_id: str,
        *,
        path_params: dict[str, str] | None = None,
        body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        method, path = _operation_route(operation_id, **(path_params or {}))
        return self._json(method, path.lstrip("/"), body, headers)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"}

    def _url(self, path: str) -> str:
        return urljoin(self._base_url, path)

    @staticmethod
    def _http_error(error: HTTPError) -> LiteHarnessError:
        try:
            payload = json.loads(error.read())
            detail = payload.get("error", {})
            if detail.get("version") != 1:
                raise ValueError("unsupported error envelope")
            return LiteHarnessError(
                detail.get("message", f"HTTP {error.code}"),
                error.code,
                code=detail.get("code", "request_failed"),
                retryable=detail.get("retryable", False),
                retry_after_ms=detail.get("retryAfterMs"),
                details=detail.get("details"),
            )
        except Exception:
            return LiteHarnessError(f"HTTP {error.code}", error.code, code="invalid_error_response")


def _validate_operation_coverage() -> None:
    generated = {operation_id: (method, path) for method, path, operation_id in API_OPERATIONS}
    expected_authenticated = {
        operation_id for operation_id, (_, path) in generated.items() if path.startswith("/v1/")
    }
    mapped = set(AUTHENTICATED_OPERATION_METHODS)
    if mapped != expected_authenticated:
        missing = sorted(expected_authenticated - mapped)
        unexpected = sorted(mapped - expected_authenticated)
        raise RuntimeError(
            f"Python SDK authenticated OpenAPI operation mismatch: missing={missing}, unexpected={unexpected}"
        )
    excluded = set(generated) - expected_authenticated
    if excluded != set(_EXCLUDED_OPERATION_IDS):
        raise RuntimeError(
            f"Python SDK public operation exclusions drifted: expected={sorted(_EXCLUDED_OPERATION_IDS)}, "
            f"actual={sorted(excluded)}"
        )
    missing_methods = sorted(
        method_name
        for method_name in AUTHENTICATED_OPERATION_METHODS.values()
        if not callable(getattr(LiteHarnessClient, method_name, None))
    )
    if missing_methods:
        raise RuntimeError(f"Python SDK OpenAPI operations have no client method: {missing_methods}")

    expected_routes = tuple(
        (method, path, operation_id, AUTHENTICATED_OPERATION_METHODS[operation_id])
        for method, path, operation_id in API_OPERATIONS
        if path.startswith("/v1/")
    )
    if AUTHENTICATED_OPERATION_ROUTES != expected_routes:
        raise RuntimeError("Python SDK authenticated OpenAPI method/path/verb inventory drifted")


def _operation_route(operation_id: str, **path_params: str) -> tuple[str, str]:
    try:
        method, template = _OPERATION_ROUTES_BY_ID[operation_id]
    except KeyError as error:
        raise ValueError(f"Unknown OpenAPI operation: {operation_id}") from error
    names = re.findall(r"\{([^}]+)\}", template)
    missing = sorted(set(names) - set(path_params))
    if missing:
        raise ValueError(f"Missing path parameters for {operation_id}: {missing}")
    unexpected = sorted(set(path_params) - set(names))
    if unexpected:
        raise ValueError(f"Unexpected path parameters for {operation_id}: {unexpected}")
    path = template
    for name in names:
        path = path.replace("{" + name + "}", quote(path_params[name], safe=""))
    return method, path


_TERMINAL_RUN_STATUSES = frozenset({"SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "ORPHANED"})


def _iter_sse_payloads(response: Any) -> Iterator[dict[str, Any]]:
    data_lines: list[str] = []
    for raw in response:
        line = raw.decode("utf-8").rstrip("\r\n")
        if not line:
            if data_lines:
                try:
                    payload = json.loads("\n".join(data_lines))
                except json.JSONDecodeError as error:
                    raise LiteHarnessError(
                        "Event stream returned invalid JSON",
                        code="invalid_event_stream_frame",
                    ) from error
                data_lines.clear()
                if not isinstance(payload, dict):
                    raise LiteHarnessError("Event stream returned an invalid frame", code="invalid_event_stream_frame")
                yield payload
            continue
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())


def _validate_event_payload(payload: dict[str, Any], run_id: str) -> None:
    if isinstance(payload.get("message"), str) and not isinstance(payload.get("runId"), str):
        raise LiteHarnessError(payload["message"], code="event_stream_error", retryable=True)
    if payload.get("runId") != run_id:
        if isinstance(payload.get("runId"), str):
            raise LiteHarnessError("Event stream returned a different run", code="event_stream_run_mismatch")
        raise LiteHarnessError("Event stream returned an invalid event", code="invalid_event_stream_frame")
    sequence = payload.get("sequence")
    if (
        not isinstance(sequence, int)
        or isinstance(sequence, bool)
        or sequence < 1
        or not isinstance(payload.get("type"), str)
        or not isinstance(payload.get("payload"), dict)
        or not isinstance(payload.get("createdAt"), str)
    ):
        raise LiteHarnessError("Event stream returned an invalid event", code="invalid_event_stream_frame")


def _is_retryable_event_stream_error(error: BaseException) -> bool:
    if isinstance(error, LiteHarnessError):
        return error.code == "event_stream_error" or error.retryable or (error.status is not None and error.status >= 500)
    return isinstance(error, (OSError, TimeoutError))


_validate_operation_coverage()
