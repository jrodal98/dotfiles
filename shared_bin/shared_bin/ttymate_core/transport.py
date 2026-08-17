"""HTTP transport abstractions used by ttymate backends."""

from __future__ import annotations

import http.client
import urllib.request
from abc import ABC, abstractmethod


class Transport(ABC):
    """Open an HTTP request using backend-specific connection policy."""

    @abstractmethod
    def open(
        self, request: urllib.request.Request, timeout: int
    ) -> http.client.HTTPResponse: ...


class RejectRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Keep credentials and connection policy bound to the configured origin."""

    def redirect_request(
        self,
        request: urllib.request.Request,
        fp: object,
        code: int,
        message: str,
        headers: object,
        new_url: str,
    ) -> None:
        return None


class StandardTransport(Transport):
    """Use standard TLS settings and honor the caller's proxy environment."""

    def open(
        self, request: urllib.request.Request, timeout: int
    ) -> http.client.HTTPResponse:
        return urllib.request.build_opener(RejectRedirectHandler()).open(
            request, timeout=timeout
        )
