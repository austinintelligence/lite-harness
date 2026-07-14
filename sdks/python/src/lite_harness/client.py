from __future__ import annotations

import json
import uuid
from collections.abc import Iterator
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urljoin
from urllib.request import Request, urlopen


class LiteHarnessError(RuntimeError):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class LiteHarnessClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        tenant_id: str | None = None,
        user_id: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        if not base_url or not token:
            raise ValueError("base_url and token are required")
        self._base_url = base_url.rstrip("/") + "/"
        self._token = token
        self._tenant_id = tenant_id
        self._user_id = user_id
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
        return self._json("POST", "v1/runs", body, {"Idempotency-Key": idempotency_key or str(uuid.uuid4())})

    def get_run(self, run_id: str) -> dict[str, Any]:
        return self._json("GET", f"v1/runs/{quote(run_id, safe='')}")

    def cancel_run(self, run_id: str) -> dict[str, Any]:
        return self._json("POST", f"v1/runs/{quote(run_id, safe='')}/cancel")

    def steer_run(self, run_id: str, instruction: str) -> dict[str, Any]:
        return self._json("POST", f"v1/runs/{quote(run_id, safe='')}/steer", {"instruction": instruction})

    def get_attempts(self, run_id: str) -> list[dict[str, Any]]:
        return self._json("GET", f"v1/runs/{quote(run_id, safe='')}/attempts")["attempts"]

    def get_children(self, run_id: str) -> list[dict[str, Any]]:
        return self._json("GET", f"v1/runs/{quote(run_id, safe='')}/children")["runs"]

    def resolve_approval(self, approval_id: str, approved: bool) -> dict[str, Any]:
        return self._json("POST", f"v1/approvals/{quote(approval_id, safe='')}", {"approved": approved})

    def events(self, run_id: str, after: int = 0) -> Iterator[dict[str, Any]]:
        query = urlencode({"after": after})
        request = Request(
            self._url(f"v1/runs/{quote(run_id, safe='')}/events?{query}"),
            headers={**self._headers(), "Accept": "text/event-stream"},
        )
        try:
            with urlopen(request, timeout=self._timeout) as response:  # noqa: S310 - caller chooses the service URL
                data_lines: list[str] = []
                for raw in response:
                    line = raw.decode("utf-8").rstrip("\r\n")
                    if not line:
                        if data_lines:
                            payload = json.loads("\n".join(data_lines))
                            data_lines.clear()
                            if "runId" not in payload:
                                raise LiteHarnessError(str(payload.get("message", "SSE stream error")))
                            yield payload
                        continue
                    if line.startswith("data:"):
                        data_lines.append(line[5:].lstrip())
        except HTTPError as error:
            raise self._http_error(error) from error

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

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._token}",
            **({"X-Lite-Tenant-Id": self._tenant_id} if self._tenant_id else {}),
            **({"X-Lite-User-Id": self._user_id} if self._user_id else {}),
        }

    def _url(self, path: str) -> str:
        return urljoin(self._base_url, path)

    @staticmethod
    def _http_error(error: HTTPError) -> LiteHarnessError:
        try:
            payload = json.loads(error.read())
            message = payload.get("error", {}).get("message", f"HTTP {error.code}")
        except Exception:
            message = f"HTTP {error.code}"
        return LiteHarnessError(message, error.code)
