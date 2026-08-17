"""Backend-neutral HTTP client with fallback and SSE streaming."""

from __future__ import annotations

import codecs
import http.client
import json
import sys
import urllib.error
import urllib.request
from collections.abc import Iterator

from .backends import ResolvedBackend
from .config import DEFAULT_TIMEOUT
from .errors import TransportError
from .protocols import Protocol


def _http_error_text(error: urllib.error.HTTPError) -> str:
    err_text = ""
    try:
        err_bytes = error.read()
        err_text = err_bytes.decode("utf-8", "replace")[:800]
        try:
            err_obj = json.loads(err_text)
            if isinstance(err_obj, dict):
                nested = err_obj.get("error")
                if isinstance(nested, dict):
                    err_text = str(nested.get("message", err_text))[:800]
                elif "message" in err_obj:
                    err_text = str(err_obj["message"])[:800]
        except json.JSONDecodeError:
            pass
    except OSError:
        err_text = str(error.reason)[:800]
    return err_text


def _iter_sse_deltas(
    response: http.client.HTTPResponse, protocol: Protocol
) -> Iterator[str]:
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    buffer = ""
    pending_event: str | None = None
    while True:
        chunk = response.read1(4096)
        if not chunk:
            tail = buffer.strip()
            if tail.startswith("data:"):
                tail = tail[5:].strip()
            if tail.startswith("{"):
                delta = protocol.parse_stream_chunk(tail, pending_event)
                if delta:
                    yield delta
            return
        buffer += decoder.decode(chunk)
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            stripped = line.strip()
            if not stripped or stripped.startswith(":"):
                continue
            if stripped.startswith("event:"):
                pending_event = stripped[6:].strip()
                continue
            if stripped.startswith("data:"):
                stripped = stripped[5:].strip()
                if stripped == "[DONE]":
                    return
            if stripped.startswith("{"):
                delta = protocol.parse_stream_chunk(stripped, pending_event)
                if delta:
                    yield delta
                pending_event = None


class Client:
    """Send requests using a backend's resolved protocol and transport policy."""

    def __init__(
        self, resolved: ResolvedBackend, timeout: int = DEFAULT_TIMEOUT
    ) -> None:
        self.resolved = resolved
        self.timeout = timeout

    def _body(self, prompt: str, stream: bool) -> bytes:
        return self.resolved.protocol.build_body(
            prompt,
            self.resolved.wire_model,
            self.resolved.max_tokens,
            stream=stream,
        )

    def _headers(self, stream: bool) -> dict[str, str]:
        headers = {
            **self.resolved.protocol.build_headers(),
            **self.resolved.headers,
        }
        if stream:
            headers["accept"] = "text/event-stream"
        return headers

    def send(self, prompt: str) -> str:
        body = self._body(prompt, stream=False)
        headers = self._headers(stream=False)
        last_exc: Exception | None = None

        for index, base in enumerate(self.resolved.endpoints):
            is_last = index == len(self.resolved.endpoints) - 1
            url = self.resolved.protocol.build_url(base, self.resolved.wire_model)
            request = urllib.request.Request(
                url, data=body, headers=headers, method="POST"
            )
            try:
                with self.resolved.transport.open(request, self.timeout) as response:
                    return self.resolved.protocol.parse_response(response.read())
            except urllib.error.HTTPError as error:
                err_text = _http_error_text(error)
                last_exc = TransportError(
                    f"[{self.resolved.name} {error.code}] {err_text}", err_text
                )
                retryable = error.code == 429 or 500 <= error.code < 600
                if not is_last and retryable:
                    self._warn_retry(error.code, url)
                    continue
                raise last_exc from error
            except TransportError as error:
                last_exc = error
                if not is_last:
                    self._warn_retry(error, url)
                    continue
                raise
            except OSError as error:
                last_exc = TransportError(f"Transport error at {url}: {error}", None)
                if not is_last:
                    self._warn_retry(error, url)
                    continue
                raise last_exc from error

        if last_exc is not None:
            raise last_exc
        raise TransportError("No backend endpoints configured")

    def stream(self, prompt: str) -> Iterator[str]:
        body = self._body(prompt, stream=True)
        headers = self._headers(stream=True)
        last_exc: Exception | None = None

        for index, base in enumerate(self.resolved.endpoints):
            is_last = index == len(self.resolved.endpoints) - 1
            url = self.resolved.protocol.build_url(
                base, self.resolved.wire_model, stream=True
            )
            request = urllib.request.Request(
                url, data=body, headers=headers, method="POST"
            )
            try:
                response = self.resolved.transport.open(request, self.timeout)
            except urllib.error.HTTPError as error:
                err_text = _http_error_text(error)
                last_exc = TransportError(
                    f"[{self.resolved.name} {error.code}] {err_text}", err_text
                )
                retryable = error.code == 429 or 500 <= error.code < 600
                if not is_last and retryable:
                    self._warn_retry(error.code, url)
                    continue
                raise last_exc from error
            except TransportError as error:
                last_exc = error
                if not is_last:
                    self._warn_retry(error, url)
                    continue
                raise
            except OSError as error:
                last_exc = TransportError(f"Transport error at {url}: {error}", None)
                if not is_last:
                    self._warn_retry(error, url)
                    continue
                raise last_exc from error

            yielded_any = False
            try:
                with response:
                    for delta in _iter_sse_deltas(response, self.resolved.protocol):
                        yielded_any = True
                        yield delta
                return
            except OSError as error:
                if yielded_any:
                    return
                last_exc = TransportError(f"Transport error at {url}: {error}", None)
                if not is_last:
                    self._warn_retry(error, url)
                    continue
                raise last_exc from error

        if last_exc is not None:
            raise last_exc
        raise TransportError("No backend endpoints configured")

    def _warn_retry(self, error: object, url: str) -> None:
        print(
            f"ttymate: {self.resolved.name} error at {url} ({error}), "
            "retrying fallback...",
            file=sys.stderr,
        )
